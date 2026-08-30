# 书架星系数据来源

`public/data/catalog.json` 是由 `scripts/build-catalog.mjs` 从 Project Gutenberg 的官方机器可读离线目录构建的静态快照。原始下载文件只保存在 `data/raw/`，该目录已被 `.gitignore` 排除，也不会被 Vite 复制进线上 Demo。

## 目录来源

- 官方离线目录说明：[Project Gutenberg Offline Catalogs](https://www.gutenberg.org/ebooks/offline_catalogs.html)
- 本次构建输入：[pg_catalog.csv.gz](https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz)
- 单本作品页面：`https://www.gutenberg.org/ebooks/<Text#>`
- Project Gutenberg 许可说明：[Terms of Use / License](https://www.gutenberg.org/policy/license)

目录中的每个节点都是 `Type=Text` 的真实 Project Gutenberg 文本记录，使用 `Text#` 生成稳定 ID（例如 `pg-1342`），并以规范化题名和作者选择一个代表记录，避免同一作品仅因译本语言不同而渲染成多颗星。主题和书架分类来自目录原字段；关系只根据共享主题、主题词、作者、语言和年代分组生成，不把推测性的文学史影响写成事实。

`pg_catalog.csv` 没有下载次数字段，因此 `downloads` 明确为 `null`，表示“官方目录未报告”，不是零次下载。若后续接入含下载统计的来源，应在构建器中增加独立的、可追溯的 enrichment 步骤，而不是猜测数值。

## 许可与展示说明

Project Gutenberg 的目录元数据、电子文本和商标/商号的适用条款并不完全相同；使用者应遵守其许可页以及所在司法辖区的版权要求。本 Demo 只提交目录字段和来源链接，不重新分发 Gutenberg 正文。作品页面链接用于溯源，项目名称不表示 Project Gutenberg 对本项目的背书。

## 重建与检查

在仓库根目录运行：

```text
node scripts/build-catalog.mjs
node scripts/check-catalog.mjs
```

默认输出至少 20,000 个去重作品节点和至少 50,000 条关系，并写入 `public/data/manifest.json`。构建器只使用 Node.js 内置模块；若已有本地 CSV，可使用 `--input path/to/pg_catalog.csv` 离线重建。通过 `--generated-at 2026-08-23T00:00:00Z` 可以固定快照时间。
