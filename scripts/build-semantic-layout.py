#!/usr/bin/env python3
"""Build a deterministic semantic 3D layout for a rich book catalogue.

The input is intentionally a separate, human-auditable file rather than the
large Gutenberg catalogue used by the first prototype::

    data/rich/books.json

Each input record must contain ``id``, ``title``, ``originalTitle``,
``author``, ``year``, ``language``, ``country``, ``summary``, ``themes``,
``popularity`` and ``metadataCompleteness``.  The generated file is a
rendering-oriented index.  It does not replace the source book records and it
does not invent summaries or translations for incomplete records.

The pipeline deliberately never materialises an N x N similarity matrix.
scikit-learn's chunked nearest-neighbour implementation is used for cosine
search, and UMAP is fitted directly from the embeddings.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
from pathlib import Path
from typing import Any, Iterable, Sequence

# Transformers inspects these flags during import. Set them before any data
# dependency is imported so a globally installed TensorFlow/Keras 3 cannot
# divert this Torch-only SentenceTransformers pipeline into the TF backend.
os.environ["USE_TORCH"] = "1"
os.environ["USE_TF"] = "0"
os.environ["TRANSFORMERS_NO_TF"] = "1"


MODEL_NAME = "BAAI/bge-small-zh-v1.5"
DEFAULT_INPUT = Path("data/rich/books.json")
DEFAULT_OUTPUT = Path("data/rich/layout.json")
DEFAULT_SEED = 17
DEFAULT_K = 16
DEFAULT_CANDIDATE_K = 96
MIN_K = 12
MAX_K = 18
COORDINATE_LIMIT = 150.0
COORDINATE_PERCENTILE_LIMIT = 130.0
SHAPES = ("orb", "ring", "diamond", "petal", "seed", "cross", "flare")
BASIS_VOCABULARY = ("多维书目语义相似度", "主题", "作者", "时代", "地域")
UNKNOWN_METADATA = {"", "未知", "不详", "未注明", "未詳", "无", "n/a", "na", "none", "null", "unknown", "-"}
UNKNOWN_AUTHORS = UNKNOWN_METADATA | {"佚名", "匿名", "anonymous", "unknown author"}
GENERIC_THEME_LABELS = frozenset(
    {
        "阅读与人性",
        "时代与命运",
        "世界文学",
        "文本叙事",
        "作品语境",
        "阅读路径",
        "未分类",
        "主题未知",
        "未分类/主题未知",
        "閱讀與人性",
        "時代與命運",
        "世界文學",
        "未分類",
    }
)


class LayoutError(RuntimeError):
    """A user-actionable input or dependency error."""


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Encode rich book records and build a deterministic 3D UMAP layout."
    )
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--model", default=MODEL_NAME)
    parser.add_argument(
        "--neighbors",
        type=int,
        default=DEFAULT_K,
        help=f"semantic neighbours per book ({MIN_K}-{MAX_K}, default: {DEFAULT_K})",
    )
    parser.add_argument(
        "--candidate-neighbors",
        type=int,
        default=DEFAULT_CANDIDATE_K,
        help=f"candidate neighbours used for relation selection (default: {DEFAULT_CANDIDATE_K})",
    )
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument(
        "--umap-neighbors",
        type=int,
        default=20,
        help="UMAP graph neighbourhood (default: 20); it is clamped to the catalogue size",
    )
    return parser.parse_args(argv)


def fail(message: str) -> "NoReturn":
    raise LayoutError(message)


def clean_text(value: Any) -> str:
    return " ".join(str(value or "").replace("\ufeff", "").split()).strip()


def known_metadata(value: str) -> bool:
    return clean_text(value).casefold() not in UNKNOWN_METADATA


def known_author(value: str) -> bool:
    return clean_text(value).casefold() not in UNKNOWN_AUTHORS


def meaningful_theme_set(themes: Iterable[str]) -> set[str]:
    return {
        theme.casefold()
        for theme in themes
        if clean_text(theme).casefold() not in GENERIC_THEME_LABELS
    }


def clip_text(value: Any, limit: int = 1800) -> str:
    text = clean_text(value)
    return text if len(text) <= limit else f"{text[:limit - 1]}…"


def as_float(value: Any, field: str, index: int, *, minimum: float | None = None) -> float:
    if isinstance(value, bool):
        fail(f"book {index} field {field!r} must be numeric")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise LayoutError(f"book {index} field {field!r} must be numeric") from exc
    if not math.isfinite(number):
        fail(f"book {index} field {field!r} must be finite")
    if minimum is not None and number < minimum:
        fail(f"book {index} field {field!r} must be >= {minimum}")
    return number


def normalise_themes(value: Any, index: int) -> list[str]:
    if isinstance(value, str):
        values: Iterable[Any] = value.replace("；", ";").split(";")
    elif isinstance(value, list):
        values = value
    else:
        fail(f"book {index} field 'themes' must be a string or array")
    seen: set[str] = set()
    result: list[str] = []
    for item in values:
        theme = clean_text(item)
        if theme and theme not in seen:
            seen.add(theme)
            result.append(theme)
    return result[:24]


def normalise_year(value: Any, index: int) -> int | None:
    if value in (None, ""):
        return None
    try:
        year = int(value)
    except (TypeError, ValueError) as exc:
        raise LayoutError(f"book {index} field 'year' must be an integer or null") from exc
    if year < -4000 or year > 3000:
        fail(f"book {index} field 'year' is outside the supported range")
    return year


def load_books(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        fail(
            f"rich catalogue not found: {path}. Create the real data/rich/books.json first; "
            "the semantic layout generator will not fabricate book records."
        )
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON in {path}: {exc}")
    # Rich catalogues are normally emitted as auditable snapshots.  Keep the
    # original array form as a small compatibility path for hand-curated
    # imports, but prefer the snapshot's canonical ``books`` array.
    if isinstance(payload, dict):
        if not isinstance(payload.get("books"), list):
            fail(f"{path} snapshot must contain a 'books' array")
        records = payload["books"]
    elif isinstance(payload, list):
        records = payload
    else:
        fail(f"{path} must contain a snapshot object with 'books' or an array of records")
    if len(records) < 2:
        fail("at least two rich book records are required to build a layout")

    required = {
        "id",
        "title",
        "originalTitle",
        "author",
        "year",
        "language",
        "country",
        "summary",
        "themes",
        "popularity",
        "metadataCompleteness",
    }
    ids: set[str] = set()
    books: list[dict[str, Any]] = []
    for index, raw in enumerate(records):
        if not isinstance(raw, dict):
            fail(f"book {index} must be an object")
        missing = sorted(required - raw.keys())
        if missing:
            fail(f"book {index} is missing required fields: {', '.join(missing)}")
        book_id = clean_text(raw.get("id"))
        title = clean_text(raw.get("title"))
        author = clean_text(raw.get("author"))
        if not book_id or not title or not author:
            fail(f"book {index} must have non-empty id, title and author")
        if book_id in ids:
            fail(f"duplicate book id: {book_id}")
        ids.add(book_id)
        completeness = as_float(raw.get("metadataCompleteness"), "metadataCompleteness", index)
        if completeness < 0.0 or completeness > 1.0:
            fail(f"book {index} field 'metadataCompleteness' must be between 0 and 1")
        books.append(
            {
                "id": book_id,
                "title": title,
                "originalTitle": clean_text(raw.get("originalTitle")),
                "author": author,
                "year": normalise_year(raw.get("year"), index),
                "language": clean_text(raw.get("language")),
                "country": clean_text(raw.get("country")),
                "summary": clean_text(raw.get("summary")),
                "themes": normalise_themes(raw.get("themes"), index),
                "popularity": as_float(raw.get("popularity"), "popularity", index, minimum=0.0),
                "metadataCompleteness": completeness,
            }
        )
    return books


def era_label(year: int | None) -> str:
    if year is None:
        return "时代未知"
    if year < 0:
        return f"公元前{abs(year) // 100 * 100}年前后"
    decade = (year // 10) * 10
    return f"{decade}年代"


def encoding_text(book: dict[str, Any]) -> str:
    """Keep all six semantic axes explicit for the multilingual encoder."""

    themes = "、".join(book["themes"]) or "主题未知"
    return "\n".join(
        (
            f"标题：{clip_text(book['title'], 360)}",
            f"原题名：{clip_text(book['originalTitle'], 360) or '无'}",
            f"作者：{clip_text(book['author'], 260)}",
            f"中文摘要：{clip_text(book['summary']) or '摘要未提供'}",
            f"主题：{clip_text(themes, 720)}",
            f"时代：{era_label(book['year'])}；年份：{book['year'] or '未知'}",
            f"地域：{clip_text(book['country'], 120) or '地域未知'}；语言：{clip_text(book['language'], 120) or '语言未知'}",
        )
    )


def set_deterministic_seeds(seed: int) -> None:
    random.seed(seed)
    os.environ.setdefault("PYTHONHASHSEED", str(seed))
    try:
        import numpy as np

        np.random.seed(seed)
    except ImportError:
        pass
    try:
        import torch

        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except ImportError:
        pass


def import_dependencies() -> tuple[Any, Any, Any, Any]:
    # Some development machines have TensorFlow/Keras installed globally.
    # SentenceTransformers only needs the PyTorch path here; selecting it
    # before importing transformers avoids an unrelated Keras 3 compatibility
    # error and keeps the data build reproducible.
    os.environ["USE_TORCH"] = "1"
    os.environ["USE_TF"] = "0"
    try:
        import numpy as np
        from sentence_transformers import SentenceTransformer
        from sklearn.neighbors import NearestNeighbors
        from umap import UMAP
    except ImportError as exc:
        fail(
            "semantic layout dependencies are missing. Install them with "
            "python -m pip install -r requirements-data.txt"
        )
    return np, SentenceTransformer, NearestNeighbors, UMAP


def filter_self_knn(
    distances: Any,
    indices: Any,
    ids: Sequence[str],
    limit: int,
) -> tuple[Any, Any]:
    """Remove self by index, then deterministically sort each kNN row.

    ``kneighbors`` is allowed to return the query point anywhere in a row;
    never assume it is the first column.  The explicit filter also makes this
    correct when duplicate/zero-distance embeddings create ties.
    """

    import numpy as np

    result_indices = np.empty((indices.shape[0], limit), dtype=np.int64)
    result_distances = np.empty((indices.shape[0], limit), dtype=np.float64)
    for row in range(indices.shape[0]):
        candidates = [
            (float(distance), int(neighbour))
            for distance, neighbour in zip(distances[row], indices[row], strict=True)
            if int(neighbour) != row
        ]
        candidates.sort(key=lambda item: (item[0], ids[item[1]]))
        if len(candidates) < limit:
            fail(f"semantic/spatial kNN returned fewer than {limit} non-self neighbours for row {row}")
        for column, (distance, neighbour) in enumerate(candidates[:limit]):
            result_distances[row, column] = distance
            result_indices[row, column] = neighbour
    return result_distances, result_indices


def robust_unit(values: Any, np: Any, *, invert: bool = False) -> Any:
    values = np.asarray(values, dtype=np.float64)
    low, high = np.quantile(values, [0.05, 0.95])
    if not math.isfinite(float(low)) or not math.isfinite(float(high)) or high - low < 1e-9:
        result = np.full(values.shape, 0.5, dtype=np.float64)
    else:
        result = np.clip((values - low) / (high - low), 0.0, 1.0)
    return 1.0 - result if invert else result


def robust_normalise_coordinates(coords: Any, np: Any) -> Any:
    coords = np.asarray(coords, dtype=np.float64)
    if coords.ndim != 2 or coords.shape[1] != 3:
        fail("UMAP did not return a finite three-dimensional coordinate array")
    if not np.isfinite(coords).all():
        fail("UMAP returned non-finite coordinates")
    median = np.median(coords, axis=0)
    low, high = np.quantile(coords, [0.01, 0.99], axis=0)
    span = np.maximum(np.maximum(np.abs(low - median), np.abs(high - median)), 1e-6)
    fallback = np.maximum(np.std(coords, axis=0), 1.0)
    span = np.where(span < 1e-5, fallback, span)
    normalised = (coords - median) / span * COORDINATE_PERCENTILE_LIMIT
    normalised = np.clip(normalised, -COORDINATE_LIMIT, COORDINATE_LIMIT)
    if not np.isfinite(normalised).all():
        fail("coordinate normalisation produced non-finite values")
    return normalised


def stable_hash(value: str) -> int:
    result = 0xCBF29CE484222325
    for byte in value.encode("utf-8"):
        result ^= byte
        result = (result * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return result


def metadata_metrics(first: dict[str, Any], second: dict[str, Any]) -> dict[str, Any]:
    first_themes = meaningful_theme_set(first["themes"])
    second_themes = meaningful_theme_set(second["themes"])
    second_theme_keys = second_themes
    shared_themes = [
        theme
        for theme in first["themes"]
        if theme.casefold() in second_theme_keys and theme.casefold() not in GENERIC_THEME_LABELS
    ]
    union = first_themes | second_themes
    theme_overlap = len(first_themes & second_themes) / len(union) if union else 0.0
    era_known = first["year"] is not None and second["year"] is not None
    if not era_known:
        era_gap = 0.0
    else:
        era_gap = min(abs(first["year"] - second["year"]) / 180.0, 1.0)
    first_language = first["language"].casefold()
    second_language = second["language"].casefold()
    first_country = first["country"].casefold()
    second_country = second["country"].casefold()
    language_gap = 0.0 if known_metadata(first_language) and first_language == second_language else 1.0
    country_known = known_metadata(first_country) and known_metadata(second_country)
    country_gap = 0.0 if country_known and first_country == second_country else 1.0
    first_author = first["author"].casefold()
    second_author = second["author"].casefold()
    author_known = known_author(first_author) and first_author == second_author
    author_gap = 0.0 if author_known else 1.0
    theme_gap = 1.0 - theme_overlap
    metadata_span = min(
        1.0,
        0.35 * era_gap + 0.18 * language_gap + 0.22 * country_gap + 0.15 * author_gap + 0.10 * theme_gap,
    )
    return {
        "themeOverlap": theme_overlap,
        "sharedThemes": shared_themes,
        "eraGap": era_gap,
        "languageGap": language_gap,
        "countryGap": country_gap,
        "authorGap": author_gap,
        "eraKnown": era_known,
        "countryKnown": country_known,
        "authorKnown": author_known,
        "metadataSpan": metadata_span,
    }


def relation_basis(metrics: dict[str, Any]) -> list[str]:
    basis = [BASIS_VOCABULARY[0]]
    if float(metrics["themeOverlap"]) >= 0.12:
        basis.append("主题")
    if bool(metrics["authorKnown"]):
        basis.append("作者")
    # A time basis means an explicit historical span, not merely that two
    # records happen to share a decade. This keeps low-information
    # same-era edges visual-only rather than navigable detours.
    if bool(metrics["eraKnown"]) and float(metrics["eraGap"]) >= 0.20:
        basis.append("时代")
    # Country agreement or a country crossing is concrete geographic signal;
    # language alone is deliberately not sufficient.
    if bool(metrics["countryKnown"]):
        basis.append("地域")
    return basis


def relation_sentence(
    first: dict[str, Any], second: dict[str, Any], metrics: dict[str, Any]
) -> str:
    """Compose a restrained reader-facing trace from independent phrase pools.

    Numeric similarity and the complete evidence remain beside this copy for
    audits.  The visible sentence only names the two books and facts already
    present in their records, while independent deterministic choices keep a
    large catalogue from sounding like one repeated diagnostic.
    """

    first_title = f"《{first['title']}》"
    second_title = f"《{second['title']}》"
    shared_themes = [str(theme).strip() for theme in metrics.get("sharedThemes", []) if str(theme).strip()]
    # Prefer a human-sized motif over a broad century bucket when both are
    # available; the complete shared-theme list stays in evidence unchanged.
    theme = next((candidate for candidate in shared_themes if not candidate.endswith("世纪作品")), shared_themes[0] if shared_themes else "")
    era_known = bool(metrics.get("eraKnown")) and first.get("year") is not None and second.get("year") is not None
    era_signal = era_known and float(metrics.get("eraGap", 0.0)) >= 0.20
    year_span = abs(int(first["year"]) - int(second["year"])) if era_signal else None
    country_known = bool(metrics.get("countryKnown"))
    first_country = str(first.get("country", "")).strip()
    second_country = str(second.get("country", "")).strip()
    same_country = country_known and first_country.casefold() == second_country.casefold()
    author_signal = bool(metrics.get("authorKnown"))

    anchors: list[str] = []
    if theme:
        anchors.append(f"“{theme}”")
    if era_signal and year_span is not None:
        anchors.append(f"“{year_span}年的光阴”")
    if country_known:
        if same_country:
            anchors.append("“同一片土地”")
        else:
            country_pair = f"{first_country}与{second_country}"
            anchors.append(f"“{country_pair if len(country_pair) <= 10 else '两地'}之间的远方”")
    if author_signal:
        anchors.append("“同一位作者的笔迹”")
    if not anchors:
        anchors.append("“远处的微光”")

    # These pools intentionally stay independent: 12 openings x 12 encounter
    # images x 8 endings gives the public catalogue many quiet combinations.
    openings = (
        "沿着{anchor}，",
        "向着{anchor}，",
        "从{anchor}望过去，",
        "把目光投向{anchor}，",
        "当{anchor}在天边亮起，",
        "循着{anchor}往前走，",
        "让{anchor}领路，",
        "在更深处，{anchor}轻轻转身，",
        "隔着{anchor}，",
        "顺着{anchor}慢慢前行，",
        "{anchor}在远处忽然亮起，",
        "当脚步经过{anchor}，",
    )
    encounters = (
        f"{first_title}与{second_title}在无声处照面",
        f"{first_title}与{second_title}从两端慢慢靠近",
        f"{first_title}与{second_title}在一束微光里重逢",
        f"{first_title}与{second_title}隔着远近彼此照见",
        f"{first_title}与{second_title}沿着一条小径交会",
        f"{first_title}与{second_title}在同一片夜色中相认",
        f"{first_title}与{second_title}把两处光亮接在一起",
        f"{first_title}与{second_title}在书页之外轻轻碰面",
        f"{first_title}与{second_title}向彼此投来一束回声",
        f"{first_title}与{second_title}在远处交换微光",
        f"{first_title}与{second_title}像两颗远星忽然相遇",
        f"{first_title}与{second_title}随潮汐彼此靠岸",
    )
    endings = (
        "，让这一刻在远处慢慢展开",
        "，把余韵留给下一段路",
        "，等下一位漫游者在此停步",
        "，一条隐约小径由此亮起",
        "，留下尚未写完的下一页",
        "，让余光替它保守秘密",
        "，把这次偶遇轻轻收好",
        "，静静等着下一次偏航",
    )

    pair_key = "\u0000".join(sorted((str(first.get("id", "")), str(second.get("id", "")))))
    pair_hash = stable_hash(pair_key)

    def phrase_index(label: str, size: int) -> int:
        # SplitMix64 keeps the three selections independent even when their
        # pool sizes share factors; appending a suffix to FNV alone does not.
        value = (pair_hash + stable_hash(f"relation-sentence:{label}")) & 0xFFFFFFFFFFFFFFFF
        value = ((value ^ (value >> 30)) * 0xBF58476D1CE4E5B9) & 0xFFFFFFFFFFFFFFFF
        value = ((value ^ (value >> 27)) * 0x94D049BB133111EB) & 0xFFFFFFFFFFFFFFFF
        value ^= value >> 31
        return value % size

    anchor = anchors[phrase_index("anchor", len(anchors))]
    opening = openings[phrase_index("opening", len(openings))].format(anchor=anchor)
    encounter = encounters[phrase_index("encounter", len(encounters))]
    ending = endings[phrase_index("ending", len(endings))]
    sentence = f"{opening}{encounter}{ending}。"
    if len(sentence) < 35:
        sentence = sentence[:-1] + "，等一位漫游者在此停步。"
    return sentence


def relation_values(
    first: dict[str, Any],
    second: dict[str, Any],
    similarity: float,
) -> dict[str, Any] | None:
    metrics = metadata_metrics(first, second)
    basis = relation_basis(metrics)
    # Every navigable edge carries the embedding signal plus a contextual
    # theme, historical span, or geographic signal. Same-author alone is a
    # useful neighbour hint, but not enough to justify a surprise detour.
    if not any(item in {"主题", "时代", "地域"} for item in basis):
        return None
    similarity = max(0.0, min(1.0, float(similarity)))
    metadata_span = float(metrics["metadataSpan"])
    # Keep the evidence-derived score separate from its eventual display
    # scale.  Candidate edges occupy a naturally narrow cosine range, so the
    # raw value is globally percentile-calibrated before the three detour
    # bands are selected.  This preserves ordering without pretending that a
    # cosine distance of 0.31 is intrinsically a user-facing "31% surprise".
    raw_surprise = max(0.05, min(0.98, 0.08 + 0.62 * (1.0 - similarity) + 0.30 * metadata_span))
    weight = max(
        0.0,
        min(
            1.0,
            0.58 * similarity
            + 0.20 * (1.0 - metadata_span)
            + 0.12 * float(metrics["themeOverlap"])
            + 0.10 * ((first["metadataCompleteness"] + second["metadataCompleteness"]) / 2.0),
        ),
    )
    confidence = max(
        0.45,
        min(
            0.99,
            0.42 * similarity
            + 0.30 * float(metrics["themeOverlap"])
            + 0.18 * (1.0 - metadata_span)
            + 0.10 * ((first["metadataCompleteness"] + second["metadataCompleteness"]) / 2.0),
        ),
    )
    return {
        "similarity": similarity,
        "surprise": raw_surprise,
        "weight": weight,
        "confidence": confidence,
        "basis": basis,
        "sentence": relation_sentence(first, second, metrics),
        "evidence": {
            "themeOverlap": float(metrics["themeOverlap"]),
            "eraGap": float(metrics["eraGap"]),
            "languageGap": float(metrics["languageGap"]),
            "countryGap": float(metrics["countryGap"]),
            "authorGap": float(metrics["authorGap"]),
            "metadataSpan": metadata_span,
            "rawSurprise": raw_surprise,
            "sharedThemes": list(metrics["sharedThemes"]),
            "eraKnown": bool(metrics["eraKnown"]),
            "countryKnown": bool(metrics["countryKnown"]),
            "authorKnown": bool(metrics["authorKnown"]),
        },
    }


def rounded(value: Any, digits: int = 6) -> float:
    return round(float(value), digits)


def star_shape(book_id: str, density: float, outlier: float) -> str:
    """Choose a restrained morphology with semantic bias and stable variety.

    Dense cores may receive a rare diffraction flare; true outer-tail books
    preferentially become rings.  The remaining deterministic distribution
    keeps soft stars dominant and cross-like stars below roughly one sixth of
    the field instead of assigning seven shader names uniformly at random.
    """

    value = (stable_hash(f"{book_id}:shape") % 10_000) / 10_000.0
    if outlier >= 0.78 and value < 0.68:
        return "ring"
    if density >= 0.82 and value < 0.20:
        return "flare"
    if value < 0.42:
        return "orb"
    if value < 0.60:
        return "seed"
    if value < 0.78:
        return "petal"
    if value < 0.90:
        return "ring"
    if value < 0.955:
        return "diamond"
    if value < 0.985:
        return "cross"
    return "flare"


def rank_values(values: Any, np: Any) -> Any:
    """Average-tie ranks without importing scipy."""

    values = np.asarray(values, dtype=np.float64)
    order = np.argsort(values, kind="mergesort")
    ranks = np.empty(values.shape[0], dtype=np.float64)
    cursor = 0
    while cursor < len(order):
        end = cursor + 1
        while end < len(order) and values[order[end]] == values[order[cursor]]:
            end += 1
        rank = (cursor + 1 + end) / 2.0
        ranks[order[cursor:end]] = rank
        cursor = end
    return ranks


def spearman_correlation(first: Any, second: Any, np: Any) -> float:
    if len(first) < 2 or len(second) < 2:
        return 0.0
    first_rank = rank_values(first, np)
    second_rank = rank_values(second, np)
    first_centered = first_rank - np.mean(first_rank)
    second_centered = second_rank - np.mean(second_rank)
    denominator = float(np.sqrt(np.sum(first_centered**2) * np.sum(second_centered**2)))
    if denominator < 1e-12:
        return 0.0
    return float(np.sum(first_centered * second_centered) / denominator)


def relation_edge_key(first_index: int, second_index: int) -> tuple[int, int]:
    return (min(first_index, second_index), max(first_index, second_index))


def calibrate_relation_surprises(
    relations: dict[tuple[int, int], dict[str, Any] | None],
    ids: Sequence[str],
) -> None:
    """Map evidence-derived surprise ranks onto an auditable 0.12..0.96 scale.

    Embedding-neighbour distances are concentrated in a narrow interval.  An
    empirical CDF makes near, bridge and far detours legible while retaining
    the exact raw score in evidence. Equal raw scores receive the same average
    percentile; IDs only provide deterministic ordering between edge groups.
    """

    valid = [
        (key, relation)
        for key, relation in relations.items()
        if relation is not None
    ]
    valid.sort(
        key=lambda item: (
            float(item[1]["evidence"]["rawSurprise"]),
            ids[item[0][0]],
            ids[item[0][1]],
        )
    )
    if not valid:
        return
    denominator = max(1, len(valid) - 1)
    cursor = 0
    while cursor < len(valid):
        end = cursor + 1
        raw_value = float(valid[cursor][1]["evidence"]["rawSurprise"])
        while end < len(valid) and float(valid[end][1]["evidence"]["rawSurprise"]) == raw_value:
            end += 1
        percentile = ((cursor + end - 1) / 2.0) / denominator
        calibrated = 0.12 + 0.84 * percentile
        for _, relation in valid[cursor:end]:
            relation["surprise"] = calibrated
            relation["evidence"]["surprisePercentile"] = percentile
        cursor = end


def calibrate_selected_endpoint_surprises(
    selected: dict[tuple[int, int], dict[str, Any]],
    ids: Sequence[str],
) -> None:
    """Calibrate every final edge from both endpoint viewpoints.

    The final graph is the union of edges selected by every book. An edge may
    therefore have been chosen by only one endpoint during candidate
    selection, but it is navigable in both directions at runtime. Re-ranking
    the *final incident graph* for each endpoint gives every direction an
    explicit local surprise value and prevents the reverse journey from
    silently falling back to a global score.
    """

    incident: list[list[tuple[tuple[int, int], dict[str, Any], int]]] = [
        [] for _ in ids
    ]
    for key, relation in selected.items():
        first, second = key
        incident[first].append((key, relation, second))
        incident[second].append((key, relation, first))

    band_ranges = {
        "low": (0.18, 0.42),
        "middle": (0.58, 0.74),
        "high": (0.84, 0.95),
    }
    for relation in selected.values():
        relation["surpriseByBook"] = {}
        relation["bandByBook"] = {}

    for index, edges in enumerate(incident):
        edges.sort(
            key=lambda item: (
                float(item[1]["surprise"]),
                ids[item[2]],
            )
        )
        total = len(edges)
        groups: dict[str, list[tuple[tuple[int, int], dict[str, Any], int]]] = {
            "low": [],
            "middle": [],
            "high": [],
        }
        for rank, item in enumerate(edges):
            band = "low" if rank * 3 < total else "middle" if rank * 3 < total * 2 else "high"
            groups[band].append(item)
        for band, group in groups.items():
            low, high = band_ranges[band]
            for local_rank, (_, relation, _) in enumerate(group):
                fraction = local_rank / max(1, len(group) - 1)
                relation["surpriseByBook"][ids[index]] = low + (high - low) * fraction
                relation["bandByBook"][ids[index]] = band


def choose_relation_edges(
    books: list[dict[str, Any]],
    ids: Sequence[str],
    candidate_indices: Any,
    candidate_similarities: Any,
) -> tuple[
    dict[tuple[int, int], dict[str, Any]],
    list[dict[str, int]],
    dict[tuple[int, int], dict[str, Any] | None],
]:
    """Select honest low/middle/high-surprise edges from a wider candidate pool."""

    relation_cache: dict[tuple[int, int], dict[str, Any] | None] = {}
    selected: dict[tuple[int, int], dict[str, Any]] = {}
    selected_bands: dict[tuple[int, int], set[str]] = {}
    coverage: list[dict[str, int]] = []
    band_order = ("low", "middle", "high")

    # First evaluate the full unique candidate graph, then calibrate once.
    # Calibrating while iterating books would make the same undirected edge
    # depend on which endpoint happened to be visited first.
    for index, book in enumerate(books):
        for neighbour, similarity in zip(candidate_indices[index], candidate_similarities[index], strict=True):
            neighbour_index = int(neighbour)
            key = relation_edge_key(index, neighbour_index)
            if key not in relation_cache:
                relation_cache[key] = relation_values(book, books[neighbour_index], float(similarity))
    calibrate_relation_surprises(relation_cache, ids)

    for index, book in enumerate(books):
        eligible: list[tuple[int, dict[str, Any]]] = []
        for neighbour, similarity in zip(candidate_indices[index], candidate_similarities[index], strict=True):
            neighbour_index = int(neighbour)
            key = relation_edge_key(index, neighbour_index)
            relation = relation_cache[key]
            if relation is not None:
                eligible.append((neighbour_index, relation))

        eligible.sort(key=lambda item: (float(item[1]["surprise"]), ids[item[0]]))
        total = len(eligible)
        groups: dict[str, list[tuple[int, dict[str, Any]]]] = {band: [] for band in band_order}
        band_for_key: dict[tuple[int, int], str] = {}
        for rank, item in enumerate(eligible):
            band = "low" if rank * 3 < total else "middle" if rank * 3 < total * 2 else "high"
            groups[band].append(item)
            band_for_key[relation_edge_key(index, item[0])] = band

        # Surprise is viewpoint-dependent: a bridge that is ordinary from one
        # shelf can be a genuine rupture from the other.  Preserve the global
        # calibrated value for graph analytics, and add an endpoint-local
        # percentile for the three-button detour compass.  The separated
        # numeric intervals make the UI's 近/桥/远 labels an enforced contract.
        band_ranges = {
            "low": (0.18, 0.42),
            "middle": (0.58, 0.74),
            "high": (0.84, 0.95),
        }
        for band in band_order:
            low, high = band_ranges[band]
            group = groups[band]
            for local_rank, (neighbour_index, relation) in enumerate(group):
                fraction = local_rank / max(1, len(group) - 1)
                relation.setdefault("surpriseByBook", {})[ids[index]] = low + (high - low) * fraction
                relation.setdefault("bandByBook", {})[ids[index]] = band

        selected_for_book: set[tuple[int, int]] = set()
        selected_counts = {band: 0 for band in band_order}
        for band in band_order:
            candidates = sorted(
                groups[band],
                key=lambda item: (
                    -float(item[1]["confidence"]),
                    -float(item[1]["similarity"]),
                    float(item[1]["surprise"]),
                    ids[item[0]],
                ),
            )
            for neighbour_index, relation in candidates[:2]:
                key = relation_edge_key(index, neighbour_index)
                selected[key] = relation
                selected_bands.setdefault(key, set()).add(band)
                selected_for_book.add(key)
                selected_counts[band] += 1

        # A sparse metadata record may leave one or more bins empty. Fill only
        # from genuine eligible candidates; never fabricate a relationship.
        if len(selected_for_book) < 3:
            fallback = sorted(
                eligible,
                key=lambda item: (
                    -float(item[1]["confidence"]),
                    -float(item[1]["similarity"]),
                    float(item[1]["surprise"]),
                    ids[item[0]],
                ),
            )
            for neighbour_index, relation in fallback:
                key = relation_edge_key(index, neighbour_index)
                if key in selected_for_book:
                    continue
                band = band_for_key[key]
                selected[key] = relation
                selected_bands.setdefault(key, set()).add(band)
                selected_for_book.add(key)
                selected_counts[band] += 1
                if len(selected_for_book) >= 3:
                    break

        coverage.append(
            {
                "candidate": len(candidate_indices[index]),
                "eligible": total,
                "low": selected_counts["low"],
                "middle": selected_counts["middle"],
                "high": selected_counts["high"],
                "selected": len(selected_for_book),
            }
        )

    for key, relation in selected.items():
        relation["bands"] = [band for band in band_order if band in selected_bands.get(key, set())]
    calibrate_selected_endpoint_surprises(selected, ids)
    return selected, coverage, relation_cache


def connected_components(
    count: int, edges: dict[tuple[int, int], dict[str, Any]]
) -> tuple[int, int]:
    adjacency = [set() for _ in range(count)]
    for first, second in edges:
        adjacency[first].add(second)
        adjacency[second].add(first)
    visited: set[int] = set()
    component_count = 0
    largest = 0
    for root in range(count):
        if root in visited:
            continue
        component_count += 1
        stack = [root]
        visited.add(root)
        size = 0
        while stack:
            current = stack.pop()
            size += 1
            for neighbour in adjacency[current]:
                if neighbour not in visited:
                    visited.add(neighbour)
                    stack.append(neighbour)
        largest = max(largest, size)
    return component_count, largest


def build_layout(options: argparse.Namespace) -> dict[str, Any]:
    if not MIN_K <= options.neighbors <= MAX_K:
        fail(f"--neighbors must be between {MIN_K} and {MAX_K}")
    if options.candidate_neighbors < options.neighbors:
        fail("--candidate-neighbors must be at least --neighbors")
    if options.batch_size <= 0:
        fail("--batch-size must be positive")
    if options.umap_neighbors <= 1:
        fail("--umap-neighbors must be greater than 1")

    books = load_books(options.input)
    book_count = len(books)
    layout_k = min(options.neighbors, book_count - 1)
    candidate_k = min(options.candidate_neighbors, book_count - 1)
    if layout_k < 1 or candidate_k < 1:
        fail("the catalogue must contain at least two books")
    if book_count < MIN_K + 1:
        print(
            f"warning: only {book_count} books are available, so each book has {layout_k} neighbours "
            f"instead of the requested {options.neighbors}",
            file=sys.stderr,
        )

    np, sentence_transformer, nearest_neighbors, umap_class = import_dependencies()
    set_deterministic_seeds(options.seed)

    texts = [encoding_text(book) for book in books]
    try:
        model = sentence_transformer(options.model, device="cpu")
        embeddings = model.encode(
            texts,
            batch_size=options.batch_size,
            show_progress_bar=True,
            convert_to_numpy=True,
            normalize_embeddings=True,
            output_value="sentence_embedding",
        )
    except Exception as exc:  # dependency/model failures need a concise action
        raise LayoutError(f"failed to load or run embedding model {options.model}: {exc}") from exc
    embeddings = np.asarray(embeddings, dtype=np.float32)
    if embeddings.ndim != 2 or embeddings.shape[0] != book_count:
        fail("embedding model returned an unexpected matrix shape")
    if not np.isfinite(embeddings).all():
        fail("embedding model returned non-finite values")

    semantic_search = nearest_neighbors(
        n_neighbors=min(book_count, candidate_k + 1),
        metric="cosine",
        algorithm="brute",
        n_jobs=1,
    )
    semantic_search.fit(embeddings)
    semantic_distances, semantic_indices = semantic_search.kneighbors(embeddings, return_distance=True)
    semantic_distances, semantic_indices = filter_self_knn(
        semantic_distances,
        semantic_indices,
        [book["id"] for book in books],
        candidate_k,
    )
    semantic_similarities = np.clip(1.0 - semantic_distances, 0.0, 1.0)

    umap_k = min(max(options.umap_neighbors, layout_k + 1), book_count - 1)
    try:
        reducer = umap_class(
            n_components=3,
            n_neighbors=umap_k,
            metric="cosine",
            min_dist=0.08,
            spread=1.12,
            init="spectral",
            random_state=options.seed,
            transform_seed=options.seed,
            low_memory=True,
            densmap=True,
            dens_lambda=0.8,
            dens_frac=0.25,
            dens_var_shift=0.1,
            n_jobs=1,
        )
        raw_coordinates = reducer.fit_transform(embeddings)
    except Exception as exc:
        raise LayoutError(f"3D UMAP failed: {exc}") from exc
    coordinates = robust_normalise_coordinates(raw_coordinates, np)

    spatial_search = nearest_neighbors(
        n_neighbors=min(book_count, layout_k + 1),
        metric="euclidean",
        algorithm="auto",
        n_jobs=1,
    )
    spatial_search.fit(coordinates)
    spatial_distances, spatial_indices = spatial_search.kneighbors(coordinates, return_distance=True)
    spatial_distances, spatial_indices = filter_self_knn(
        spatial_distances,
        spatial_indices,
        [book["id"] for book in books],
        layout_k,
    )

    semantic_density_k = min(layout_k, candidate_k)
    mean_semantic_distance = np.mean(semantic_distances[:, :semantic_density_k], axis=1)
    mean_spatial_distance = np.mean(spatial_distances, axis=1)
    semantic_density = robust_unit(mean_semantic_distance, np, invert=True)
    spatial_density = robust_unit(mean_spatial_distance, np, invert=True)
    outlier_score = np.clip(
        0.84 * robust_unit(mean_semantic_distance, np)
        + 0.16 * robust_unit(mean_spatial_distance, np),
        0.0,
        1.0,
    )
    semantic_spatial_spearman = spearman_correlation(semantic_density, spatial_density, np)
    popularity = np.asarray([math.log1p(book["popularity"]) for book in books], dtype=np.float64)
    popularity_unit = robust_unit(popularity, np)

    ids = [book["id"] for book in books]
    selected_relations, relation_coverage, relation_candidates = choose_relation_edges(
        books,
        ids,
        semantic_indices,
        semantic_similarities,
    )
    relation_degrees = [0] * book_count
    for first_index, second_index in selected_relations:
        relation_degrees[first_index] += 1
        relation_degrees[second_index] += 1
    if book_count >= 4 and min(relation_degrees, default=0) < 3:
        uncovered = [
            f"{ids[index]}:{books[index]['title']}={degree}"
            for index, degree in enumerate(relation_degrees)
            if degree < 3
        ]
        fail(
            "honest relation coverage is below 3 for at least one book; "
            "the rich catalogue needs more auditable metadata before layout generation: "
            + ", ".join(uncovered[:20])
        )

    records: list[dict[str, Any]] = []
    for index, book in enumerate(books):
        semantic_neighbours: list[dict[str, Any]] = []
        spatial_ids = [ids[int(neighbour)] for neighbour in spatial_indices[index]]
        spatial_set = set(spatial_ids)
        semantic_ids = {ids[int(neighbour)] for neighbour in semantic_indices[index][:layout_k]}
        overlap = len(spatial_set & semantic_ids) / max(1, len(semantic_ids))
        for rank, (neighbour, similarity) in enumerate(
            zip(semantic_indices[index][:layout_k], semantic_similarities[index][:layout_k], strict=True),
            start=1,
        ):
            neighbour_index = int(neighbour)
            neighbour_book = books[neighbour_index]
            key = relation_edge_key(index, neighbour_index)
            relation = selected_relations.get(key)
            if relation is None:
                candidate_relation = relation_candidates.get(key)
                semantic_neighbours.append(
                    {
                        "id": neighbour_book["id"],
                        "semanticRank": rank,
                        "similarity": rounded(float(similarity)),
                        "surprise": rounded(candidate_relation["surprise"] if candidate_relation is not None else 0.5),
                        "navigable": False,
                    }
                )
            else:
                semantic_neighbours.append(
                    {
                        "id": neighbour_book["id"],
                        "semanticRank": rank,
                        "similarity": rounded(relation["similarity"]),
                        "surprise": rounded(relation.get("surpriseByBook", {}).get(book["id"], relation["surprise"])),
                        "navigable": True,
                        "basis": relation["basis"],
                        "relationKey": "\u0000".join(sorted((ids[key[0]], ids[key[1]]))),
                    }
                )

        completeness = float(book["metadataCompleteness"])
        density = float(semantic_density[index])
        outlier = float(outlier_score[index])
        pop = float(popularity_unit[index])
        coverage = relation_coverage[index]
        records.append(
            {
                "id": book["id"],
                "position": [rounded(coordinates[index, axis], 4) for axis in range(3)],
                "localDensity": rounded(density),
                "semanticDensity": rounded(float(semantic_density[index])),
                "spatialDensity": rounded(float(spatial_density[index])),
                "outlierScore": rounded(outlier),
                "magnitude": rounded(1.32 + 1.72 * math.sqrt(max(density, 0.0)) + 0.58 * completeness + 0.42 * pop),
                "halo": rounded(0.18 + 0.56 * density + 0.26 * completeness),
                "shape": star_shape(book["id"], density, outlier),
                "temperature": rounded(0.16 + 0.54 * (1.0 - density) + 0.30 * pop),
                "neighbors": semantic_neighbours,
                "spatialNeighbors": spatial_ids,
                "spatialSemanticOverlap": rounded(overlap),
                "relationCoverage": coverage,
            }
        )

    relations: list[dict[str, Any]] = []
    for (first_index, second_index), relation in sorted(selected_relations.items()):
        relations.append(
            {
                "source": ids[first_index],
                "target": ids[second_index],
                "similarity": rounded(relation["similarity"]),
                "weight": rounded(relation["weight"]),
                "surprise": rounded(relation["surprise"]),
                "surpriseByBook": {
                    book_id: rounded(value)
                    for book_id, value in sorted(relation.get("surpriseByBook", {}).items())
                    if book_id in {ids[first_index], ids[second_index]}
                },
                "bandByBook": {
                    book_id: value
                    for book_id, value in sorted(relation.get("bandByBook", {}).items())
                    if book_id in {ids[first_index], ids[second_index]}
                },
                "confidence": rounded(relation["confidence"]),
                "sentence": relation["sentence"],
                "basis": relation["basis"],
                "evidence": {
                    key: list(value) if isinstance(value, list) else value if isinstance(value, bool) else rounded(value)
                    for key, value in relation["evidence"].items()
                },
                "bands": relation["bands"],
                "provenance": "semantic-layout",
            }
        )

    surprise_values = [float(relation["surprise"]) for relation in selected_relations.values()]
    surprise_low = sum(value < 0.52 for value in surprise_values)
    surprise_middle = sum(0.52 <= value < 0.80 for value in surprise_values)
    surprise_far = sum(value >= 0.80 for value in surprise_values)

    density_values = [float(record["localDensity"]) for record in records]
    spatial_density_values = [float(record["spatialDensity"]) for record in records]
    outlier_values = [float(record["outlierScore"]) for record in records]
    overlap_values = [float(record["spatialSemanticOverlap"]) for record in records]
    density_p10, density_p50, density_p90 = np.quantile(density_values, [0.10, 0.50, 0.90])
    spatial_density_p10, spatial_density_p50, spatial_density_p90 = np.quantile(
        spatial_density_values, [0.10, 0.50, 0.90]
    )
    outlier_p10, outlier_p50, outlier_p90 = np.quantile(outlier_values, [0.10, 0.50, 0.90])
    overlap_p10, overlap_p50, overlap_p90 = np.quantile(overlap_values, [0.10, 0.50, 0.90])
    degree_p50, degree_p90 = np.quantile(relation_degrees, [0.50, 0.90])
    coordinate_min = np.min(coordinates, axis=0)
    coordinate_max = np.max(coordinates, axis=0)
    component_count, largest_component = connected_components(book_count, selected_relations)
    coverage_all_bands = sum(
        1
        for coverage_item in relation_coverage
        if coverage_item["low"] > 0 and coverage_item["middle"] > 0 and coverage_item["high"] > 0
    )
    return {
        "schemaVersion": "bookshelf-galaxy/semantic-layout-v1",
        "model": options.model,
        # A wall-clock timestamp would make identical inputs produce different
        # bytes.  This marker records the deterministic generation contract.
        "generatedAt": "deterministic",
        "seed": options.seed,
        "neighborCount": layout_k,
        "candidateNeighborCount": candidate_k,
        "umapNeighbors": umap_k,
        "dimensions": 3,
        "coordinateLimit": COORDINATE_LIMIT,
        "basisVocabulary": list(BASIS_VOCABULARY),
        "bookCount": book_count,
        "relationCount": len(relations),
        "stats": {
            "embeddingDimension": int(embeddings.shape[1]),
            "densityP10": rounded(density_p10),
            "densityP50": rounded(density_p50),
            "densityP90": rounded(density_p90),
            "semanticDensityP10": rounded(density_p10),
            "semanticDensityP50": rounded(density_p50),
            "semanticDensityP90": rounded(density_p90),
            "spatialDensityP10": rounded(spatial_density_p10),
            "spatialDensityP50": rounded(spatial_density_p50),
            "spatialDensityP90": rounded(spatial_density_p90),
            "outlierP10": rounded(outlier_p10),
            "outlierP50": rounded(outlier_p50),
            "outlierP90": rounded(outlier_p90),
            "semanticSpatialDensitySpearman": rounded(semantic_spatial_spearman),
            "spatialSemanticRecallMean": rounded(float(np.mean(overlap_values))),
            "spatialSemanticRecallP10": rounded(overlap_p10),
            "spatialSemanticRecallP50": rounded(overlap_p50),
            "spatialSemanticRecallP90": rounded(overlap_p90),
            "coordinateMin": [rounded(value, 4) for value in coordinate_min],
            "coordinateMax": [rounded(value, 4) for value in coordinate_max],
            "relationMinDegree": min(relation_degrees, default=0),
            "relationDegreeP50": rounded(degree_p50),
            "relationDegreeP90": rounded(degree_p90),
            "relationCoverageAllBands": coverage_all_bands,
            "relationCoverageAllBandsFraction": rounded(coverage_all_bands / max(1, book_count)),
            "surpriseMin": rounded(min(surprise_values, default=0.0)),
            "surpriseMax": rounded(max(surprise_values, default=0.0)),
            "surpriseBands": {
                "near": surprise_low,
                "bridge": surprise_middle,
                "far": surprise_far,
            },
            "componentCount": component_count,
            "largestComponent": largest_component,
            "largestComponentRatio": rounded(largest_component / max(1, book_count)),
        },
        "books": records,
        "relations": relations,
    }


def write_layout(path: Path, layout: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(layout, ensure_ascii=False, indent=2, separators=(",", ": "), allow_nan=False) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def main(argv: Sequence[str] | None = None) -> int:
    options = parse_args(argv or sys.argv[1:])
    try:
        layout = build_layout(options)
        write_layout(options.output, layout)
    except LayoutError as exc:
        print(f"semantic layout: {exc}", file=sys.stderr)
        return 2
    print(
        json.dumps(
            {
                "ok": True,
                "output": str(options.output),
                "books": layout["bookCount"],
                "relations": layout["relationCount"],
                "model": layout["model"],
                "seed": layout["seed"],
                "neighborCount": layout["neighborCount"],
                "candidateNeighborCount": layout["candidateNeighborCount"],
                "relationMinDegree": layout["stats"]["relationMinDegree"],
                "largestComponentRatio": layout["stats"]["largestComponentRatio"],
                "semanticSpatialDensitySpearman": layout["stats"]["semanticSpatialDensitySpearman"],
                "spatialSemanticRecallMean": layout["stats"]["spatialSemanticRecallMean"],
                "densityP10": layout["stats"]["densityP10"],
                "densityP90": layout["stats"]["densityP90"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
