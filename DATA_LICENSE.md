# 书架星系数据归属与许可说明

本文件只说明书目数据、摘要和封面等外部内容的来源与归属；项目代码按仓库 [MIT License](LICENSE) 发布，代码许可与数据许可分离，不能因为代码采用 MIT，就推断外部数据或图片也采用同一许可证。使用、再分发或改造数据时，应同时遵守源站当前有效的条款。

## 数据来源

### Wikidata 结构化数据

书目候选、作品实体、作者、时代、语言、地域、主题以及 Wikidata 项目编号来自 Wikidata。Wikidata 的结构化数据按 CC0 1.0 公共领域贡献发布：

- [Wikidata Licensing](https://www.wikidata.org/wiki/Wikidata:Licensing)
- [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/deed.zh)

每条记录的 `wikidataUrl` 是对应作品实体的字段级回链，例如 `https://www.wikidata.org/wiki/Q...`。这些结构化字段不等于对作品正文或封面版权的授权。

### 中文维基百科作品导语

作品的中文主标题与简介主要来自中文维基百科作品页面的导语。构建时通过 MediaWiki API 请求 `zh-cn` 变体和纯文本导语，再进行 `zh-cn` 转换、空白清理，以及最多 600 个字符的截断（优先在句末截断）。少数明确列入演示路线、但导语不足 120 个汉字的作品，会从同一页面、同一固定修订的纯文本正文开头补足；其 `summaryMethod` 明确标为 `full-extract anchor fallback`。因此项目中的摘要是对原页面文本的选择和技术性整理，不是新的独立原创文本。

中文维基百科文本以 CC BY-SA 4.0 发布：

- [中文维基百科版权信息](https://zh.wikipedia.org/wiki/Wikipedia:%E7%89%88%E6%9D%83%E4%BF%A1%E6%81%AF)
- [CC BY-SA 4.0（中文）](https://creativecommons.org/licenses/by-sa/4.0/deed.zh)

每条记录的 `sourceUrl` 直接指向该书对应的中文维基百科页面，`wikipediaRevisionUrl` 指向同一页面的固定 `oldid` 修订版本。构建器会验证两者的 HTTPS、页面路径和修订号；缺少固定修订回链的记录不能通过 v2 质量门槛。该链接用于页面级归属和核验；维基百科页面的具体贡献者应以页面历史记录为准，不能在本项目中臆造单一作者署名。若再发布或实质性改编这些摘要，应保留来源链接、固定修订链接、CC BY-SA 4.0 说明，并按该许可证的相同方式共享改编文本。

### Open Library 书籍封面

可用时，`coverUrl` 使用 Open Library Covers 服务的远程图片 URL，`coverSourceUrl` 指向相应的 Open Library work 页面。项目不把 Open Library 封面声明为 CC0，也不把“有一个公开 URL”当作图片版权授权。封面可能受其原始出版物、贡献者或其他权利人的条款约束，应以 Open Library 当前说明和具体记录为准：

- [Open Library API](https://openlibrary.org/developers/api)
- [Open Library Covers API](https://openlibrary.org/dev/docs/api/covers)

构建快照只保留远程地址，不批量下载图片；没有可靠封面时，界面使用本地生成的文字书目牌作为视觉兜底。`coverSourceUrl` 没有来源时为 `null`，不会伪造封面归属。

## 字段级回链

最终 `public/data/catalog.json` 的每本书都必须保留下列字段，归属侧车 `public/data/ATTRIBUTION.json` 会按书逐条复制它们：

| 字段 | 含义 |
| --- | --- |
| `title` | 面向中文读者展示的主标题 |
| `sourceUrl` | 中文维基百科作品页/摘要来源 |
| `wikipediaRevisionUrl` | 与 `sourceUrl` 对应的固定 Wikipedia `oldid` 修订回链 |
| `wikidataUrl` | 对应 Wikidata 作品实体 |
| `coverSourceUrl` | Open Library work 回链；无可靠封面时为 `null` |

`ATTRIBUTION.json` 还记录输入 catalog 的 SHA-256，因此可以确认归属列表确实对应当前发布的 catalog，而不是另一个数据快照。条目按 `id` 稳定排序，使用相同输入重复生成应得到相同文件。

## 生成与检查

只有 v2 书目快照可以生成正式归属文件：

```powershell
node scripts/build-attribution.mjs --catalog public/data/catalog.json --output public/data/ATTRIBUTION.json
node scripts/build-attribution.mjs --check --catalog public/data/catalog.json --output public/data/ATTRIBUTION.json
```

脚本会在写文件之前拒绝旧版或不完整 catalog，特别是旧的 Project Gutenberg v1 快照；因此在 v2 尚未落地时，不能用默认命令覆盖正式 `public/data/ATTRIBUTION.json`。可以安全运行内存 smoke：

```powershell
node scripts/build-attribution.mjs --smoke
```

smoke 不读取、不写入 `public/data`，同时检查 HTTPS 回链、Wikidata Q-id、逐条字段、稳定排序与重复构建的一致性。构建后的 `--check` 会重新从 catalog 计算内容并进行严格字节级确定性比较。

## 维护约定

1. 任何过滤、合并、翻译或布局构建都不得丢弃书目的 `sourceUrl`、`wikipediaRevisionUrl`、`wikidataUrl` 或 `coverSourceUrl`。
2. 新增摘要或对摘要做实质改写时，仍需保留中文维基百科来源和 CC BY-SA 4.0 归属信息。
3. 不要在 README、演示页面或演讲中把 Open Library 封面称为 CC0；没有封面时应明确显示文字书目牌兜底。
4. catalog 发生变化后重新生成并检查 `ATTRIBUTION.json`，不要手工编辑归属清单。
