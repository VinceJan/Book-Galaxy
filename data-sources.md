# 书架星系数据来源、构建与许可

本文说明正式 v2 星海的来源、筛选、语义布局、独立的引力书线策展层、关系边界和再分发责任。发布时请把本文件与 DATA_LICENSE.md、public/data/ATTRIBUTION.json 一起阅读；它们是数据归属的说明，不是任何来源机构的背书。

## 先看正式快照

正式浏览器资源是 public/data/catalog.json，schema 为 bookshelf-galaxy/catalog-v2。对应的 public/data/manifest.json 记录生成时间、SHA-256、书数、语义关系数、来源、模型、覆盖率和关系统计。当前提交的正式快照为 **1,000 本书、5,380 条语义关系**；中文摘要覆盖率 100%，中位数 214 个汉字；571 本有 Open Library 封面（57.1%）。925 本具有可核查的具名作者记录；其余按来源标明佚名、多人合著或传统归属。每本书的最小语义关系度数为 6，1,000 本全部覆盖 `near`、`bridge`、`far` 三档。另有独立的引力书线策展层，共 **3,002 条有效书线**，覆盖 1,000 / 1,000 本书且每本至少一条。当前 catalog 的 SHA-256 为 `ef7b4aa130fef4317b1689aa27f885d6078807e2fe2e2343cd0f43ce498232a0`；精确数值仍以 manifest 与策展检查器输出为准。

正式 v2 的默认目标是 1,000 部中文主标题、内容完整的真实作品。每颗进入星海的书星都必须有可核查中文内容、来源和资格证明；如果某一批来源不能满足硬门槛，构建器会停止，不会用只有书名的记录填充数量。

下面这些文件承担不同职责：

| 文件 | 作用 | 是否发布 |
| --- | --- | --- |
| data/rich/books.json | 中文富书目、资格证明、主题来源、摘要和来源回链 | 随仓库保存的构建中间快照 |
| data/rich/eligibility-report.json | 候选接受、拒绝、隔离的审计报告 | 随仓库保存 |
| data/rich/layout.json | 语义坐标、星体参数、近邻和关系证据 | 构建中间产物 |
| src/data/curatedThreads.ts + src/data/curatedThreads/*.ts | 引力书线 / `reading-hypothesis` 独立策展层及其分片 | 随源码发布，浏览器最多取三条展示 |
| public/data/catalog.json | 富书目与语义布局的最终合并资源 | Demo 直接载入 |
| public/data/manifest.json | 当前发布快照的机器可读统计和来源信息 | Demo 与评审核验 |
| public/data/ATTRIBUTION.json | 逐本作品的来源、固定修订、Wikidata 与封面回链 | 发布归属侧车 |
| data/raw/rich-catalog/ | 网络响应缓存 | 被 gitignore，不发布 |

## 1. Wikidata：候选、结构化元数据与作品资格

### 候选查询

富书目构建器通过 [Wikidata Query Service](https://query.wikidata.org/) 选择拥有中文维基百科 sitelink 的候选，再通过 Wikidata API 批量取得实体和标签：

- [Wikidata Query Service](https://query.wikidata.org/sparql)
- [Wikidata API](https://www.wikidata.org/w/api.php)
- [Wikidata Licensing](https://www.wikidata.org/wiki/Wikidata:Licensing)

查询使用共享资格策略中列出的直接 P31 类型，并按确定性页序和分页缓存运行。它不会通过 P279* 递归子类路径把任意实体放进作品集合；旧版“只要能沿着子类找到作品类型”的宽查询会把网站、应用、人物、报告、歌曲或动漫混进书海，因此正式 v2 已明确禁止这种放宽。

scripts/lib/book-eligibility.mjs 是构建器和检查器共同使用的 fail-closed 策略：

- 固定的作品类型 allowlist 才能成为正向证据；
- hard deny 类型优先级最高；
- 系列、默认集合和无法确认的实体进入 quarantine，不为了增加数量而猜测；
- 已弃用的 P31 声明不会作为资格证据；
- 候选必须同时通过中文页面、摘要、作品类型和其他书目字段门槛；来源未署作者的传统文本保留明确“佚名”标识，不伪造作者。

每本接受的记录会保留 instanceOf，以及 eligibility.accepted、ruleId、category、matchedIds、signals、policyVersion 和 policyHash。当前快照采用 `book-galaxy-book-unit-policy-v18`，policyHash 为 `d67332fa1d86d81c3a346142c862b58037ecce29852680a477e093606eda1c64`。检查器会用共享策略重新计算它们；不是“脚本当时接受了，所以现在就相信”的一次性标记。eligibility-report.json 也保留候选的 rejected 和 quarantine 原因，便于审查过滤是否过严或数据发生了漂移。

Wikidata 结构化数据按 CC0 1.0 发布：

- [Wikidata:Licensing](https://www.wikidata.org/wiki/Wikidata:Licensing)
- [CC0 1.0（中文）](https://creativecommons.org/publicdomain/zero/1.0/deed.zh)

CC0 只覆盖 Wikidata 的结构化数据贡献，不自动覆盖书籍正文、中文维基百科文本、封面图片或未来真实图书馆的馆藏记录。每条记录的 wikidataUrl 都指向对应作品实体，便于逐字段核对。

### 作品类型和主题不是同一件事

P31 的作用是回答“这个实体是否足以作为正式书星”，不是给作品贴上完整的文学史标签。P136、P921、P1269、P642、P495 等 claim 和中文摘要只用于补充主题、作者、地域、时代及展示字段；缺失的 claim 不会被当成不存在，存在的 claim 也不等于学术上的唯一分类。

## 2. 中文维基百科：中文题名、内容与固定修订

主要中文内容来自 [中文维基百科](https://zh.wikipedia.org/) 的 MediaWiki API：

- [中文维基百科 API](https://zh.wikipedia.org/w/api.php)
- [中文维基百科版权信息](https://zh.wikipedia.org/wiki/Wikipedia:%E7%89%88%E6%9D%83%E4%BF%A1%E6%81%AF)
- [CC BY-SA 4.0（中文）](https://creativecommons.org/licenses/by-sa/4.0/deed.zh)

### 中文题名优先

构建器请求 zh-cn variant，并优先使用 MediaWiki info API 的 varianttitles。title 是面向中文读者的主标题；wikipediaTitle 保留来源页面的规范题名；originalTitle 或 foreignTitle（存在时）作为观测台的次级题名。历史缓存不具备 varianttitles 时，才使用构建器内受控的繁简回退表；这不是新的翻译服务，也不改变来源页的 canonical URL。

标题展示会移除来源标题末尾仅用于消歧的少量媒体后缀，例如“（小说）”或“（书籍）”。该清理不改写页面 URL，wikipediaTitle 和 sourceUrl 仍可用于回链。

### 摘要门槛和 anchor fallback

一般记录使用同一中文维基页面的 exintro、explaintext、variant=zh-cn 导语。正式记录必须：

- 含中文主标题；
- 有至少 120 个汉字的中文摘要；
- 通过占位文本、消歧页和异常内容检查；
- 将摘要清理为空白规范化文本，并在需要时截断到约 600 字符的句子边界；
- 保留 sourceUrl 和同一页面的固定 Wikipedia oldid 修订回链。

少数明确用于路演路线的锚点（例如《三体》《基地》《沙丘》《安娜·卡列尼娜》《活着》《红楼梦》《西游记》《百年孤独》《罪与罚》《包法利夫人》《悲惨世界》）若导语短于 120 个汉字，可以从同一页面、同一固定修订的纯文本正文开头补足。这个例外不是降低质量的通道：

- 只有预先命名的路演锚点才允许使用；
- 仍必须有中文维基页面、固定 oldid、作品资格、作者字段或“佚名”标识，以及主题等全部证明；
- 记录的 provenance.summaryMethod 会明确写成 full-extract anchor fallback；
- 内容仍来自来源页面的选择与技术性整理，不是项目凭空撰写的简介；
- 非锚点的短导语不会通过这一例外。

中文维基百科文本以 CC BY-SA 4.0 发布。若再发布、实质改编或把这些摘要放入新的数据产品，应保留中文维基百科来源、固定 oldid、许可证说明，并按适用条款处理署名和相同方式共享；具体贡献者应以页面历史为准，项目不臆造单一作者署名。sourceUrl 是页面级回链，provenance.wikipediaRevisionUrl 是与其对应的固定修订链接。

固定 oldid 的意义是让评委或维护者能回到构建时使用的页面版本，而不是被未来编辑后的页面内容悄悄替换。构建器和归属脚本会验证：

- sourceUrl 和 revision URL 必须是 HTTPS；
- revision URL 必须带 oldid；
- 两个链接必须指向同一个中文维基页面；
- 每一本书都必须有固定修订回链才能通过 v2 合并和归属检查。

### 主题来源 themeProvenance

每条记录都有至少三项中文主题，并用 themeProvenance 按主题逐项标记来源：

| 值 | 生成方式 | 解释边界 |
| --- | --- | --- |
| wikidata-claim | 来自受控的 Wikidata genre、subject 或相关 claim 标签 | 表示源数据给出的结构化描述，不代表唯一学术分类 |
| summary-rule | 中文导语中命中明确的多词或叙事信号规则 | 是可复查的文本线索，不代表模型理解了全文 |
| contextual-metadata | 由国家/地域、世纪、具体作品类型等上下文书目字段产生 | 是展示和布局的上下文，不是情节断言 |
| generic-last-resort | 受控的最后兜底主题 | 只用于满足可读性和连续布局的最低字段要求，不能单独证明两本书的文学关系 |

宽泛的“文学”“历史”“生活”等单词不会单独被当成有辨识度的主题。关系检查会排除通用兜底主题作为共享主题证据；如果一个关系不能从最终 themes、year 或 country 重算出所声称的证据，就不会进入正式可漫游关系。

## 3. Open Library：封面查找与权利边界

可用时，构建器使用 Wikidata 的 P648 Open Library ID 查询 [Open Library Search API](https://openlibrary.org/search.json)，请求作品 key、title 和 cover_i。只有同时满足下列条件才写入 coverUrl：

1. 作品有可靠的 Open Library work ID；
2. Open Library 返回真实的 cover_i；
3. 构建器可以生成 HTTPS 的 Covers URL；
4. coverSourceUrl 指向相应 Open Library work 页面。

封面 URL 的形式为 https://covers.openlibrary.org/b/id/<cover-id>-M.jpg，来源回链为 https://openlibrary.org/works/<work-id>。构建过程只保存远程地址，不批量下载或把图片复制进仓库；没有可靠匹配时，界面使用本地程序化书目牌。

参考：

- [Open Library API](https://openlibrary.org/developers/api)
- [Open Library Covers API](https://openlibrary.org/dev/docs/api/covers)

Open Library 的公开接口和 Cover Service URL 不等于每张封面的 CC0 授权。封面可能受原始出版物、贡献者或其他权利人的条款约束；项目不宣称封面图片属于公共领域，也不把“能访问 URL”当作再分发许可。部署或重新发布时请核对 Open Library 当前服务条款以及具体封面的权利状态。完整记录会把 coverSourceUrl 写入 catalog 和 ATTRIBUTION.json；缺失时明确为 null，不伪造归属。

## 4. 语义布局与书间关系

### 模型输入

scripts/build-semantic-layout.py 在离线构建阶段使用 Sentence Transformers 加载 BAAI/bge-small-zh-v1.5。每本书编码的是中文书目字段组合，包括中文题名、外文题名（如有）、作者、年代、语言、地域、主题和中文摘要。模型只负责从这些字段计算向量，不读取未提交的正文，也不自动调用在线大模型。

依赖和版本范围见 requirements-data.txt：

- Python 3.11+
- numpy
- scikit-learn
- sentence-transformers
- umap-learn
- torch

### 从向量到三维星海

流水线先对归一化向量进行 cosine kNN 搜索，再生成三个坐标维度的 DensMAP 投影。默认使用固定 seed 17、每本书 16 个布局邻居、最多 96 个关系候选和受控的 UMAP 邻域；这些参数都写进 layout 的元数据。DensMAP 让高密度语义区域保持较紧、低密度区域保留呼吸感，帮助形成连续的星系、桥和孤星，而不是按书名 hash 出一团随机点。

布局记录会为每本书保存 position、localDensity、semanticDensity、spatialDensity、outlierScore、magnitude、halo、shape、temperature、neighbors 和 spatialNeighbors。浏览器把这些字段映射为星点大小、形状、光晕、色温、尘埃密度和相对离群感；主题之间可以重叠，不把投影误读成硬边界。

### 关系如何被选出

模型近邻只是候选，不自动等于“书间事实”。关系生成器会从候选池中重新计算最终书目的证据，保留每条关系的原始证据分，并在全部候选关系上做全局经验分位校准；随后以每本书为端点，在它自己的局部候选集合中按百分位生成 `near`、`bridge`、`far` 三档可解释航线，并维护一张覆盖全书的无向关系图。检查器逐书强制验证三档都有关系覆盖。每条正式关系至少包含：

- 多维书目语义相似度；
- 主题、时代、地域中的至少一项元数据依据；作者可以作为额外依据，但不能独立替代这些元数据；
- similarity、weight、surprise、confidence；
- evidence 中可重算的共享主题、时代跨度、地域跨度和已知性标记；
- basis、关系句、bands 和 semantic provenance。

正式合并要求没有自环、悬空端点或重复无向边；每本书至少有六条诚实关系，并且 near、bridge、far 三档逐书覆盖。关系的最小覆盖、连通分量、空间—语义近邻重合、语义—空间密度相关性和三档覆盖由 check-semantic-layout.mjs 和 check-v2-catalog.mjs 验证。语义关系数量以最终 manifest.relationCount 为准；当前冻结快照为 **5,380 条**。

### 模型推断不是文学史事实

“多维书目语义相似度”表示模型在给定书目字段上的向量邻近。“主题”“时代”“地域”表示能从最终记录重算的元数据证据。它们可以共同生成一条适合探索的路径，却不证明：

- 作者之间有影响关系；
- 作品之间存在引用、改编或传播链；
- 两位作者读过彼此；
- 某种主题是作品全文的唯一或核心主题；
- 路线中的叙事词就是研究结论。

回声、镜像、暗河、裂隙、余烬、潮汐是阅读体验的叙事命名，不是学术分类。语义关系中的 sentence 只作为构建审计材料保留，不进入普通读者的作品解读出口；界面只用它们提供位置与航向，并把引力书线阅读假说和在线馆员回答分层显示。在线模型永远不是正式 catalog、坐标或关系图谱的来源。

### 引力书线 / `reading-hypothesis`：独立的策展层

引力书线不属于 BGE/DensMAP 语义关系。它回答的不是“哪些书在向量空间里相近”，而是“这两部作品还可能在哪个故事、世界知识或人类经验上相遇”。书线来自模型辅助的逐书策展式近读与联想，当前正式快照有 **3,002 条有效书线**，覆盖 1,000 / 1,000 本书且每本至少一条；它是经过自动门禁与抽样质量门禁的生成产物，不把阅读假说提升为权威结论。

每条书线都绑定真实 catalog QID，使用 `reading-hypothesis` provenance，并经过自动门禁与抽样质量门禁。它必须满足真实 QID、无自环、无向端点去重、覆盖全部 1,000 本书，同时检查分片目标分布、全局集中度、禁技术套话和高频开头/句式/收尾。书线不进入 5,380 条语义关系的计数，不参与 `near` / `bridge` / `far` 三档算法排序；观测台最多展示三条，并明确标注“阅读假说”。

完整发布命令 `npm run check` 中的 `check:curated` 负责上述结构、覆盖和文案门禁，`check:copy` 负责扫描公开界面与策展文案中的技术套话；它们与 `check:data:*` 一起运行，任何一层失败都不会发布正式 Demo。

## 5. 生成、缓存与检查

数据重建会访问外部服务，正式构建前先安装 Python 依赖：

```bash
python -m pip install -r requirements-data.txt
```

默认的一步流水线：

```bash
npm run build:data
```

它等价于：

```bash
npm run build:data:rich
npm run build:data:layout
npm run build:data:assemble
```

其中：

- build:data:rich 运行 Wikidata 候选、Wikidata 实体/标签、中文维基百科内容和 Open Library 封面元数据 enrichment，输出 data/rich/books.json 和资格报告；
- build:data:layout 在本地 CPU 上运行 BGE 中文向量、cosine kNN 和 DensMAP 三维布局，输出 data/rich/layout.json；
- build:data:assemble 重新校验两份输入，写入 catalog-v2、manifest，并生成 ATTRIBUTION.json。

网络响应和中间缓存位于 data/raw/rich-catalog/，被 .gitignore 排除；重跑会复用缓存，适合在 WDQS 或 MediaWiki 暂时限流时续跑。build-rich-catalog.mjs 支持 --limit、--candidate-multiplier 和 --refresh；--refresh 会主动刷新网络缓存，只有确认需要更新来源时使用。

检查正式快照：

```bash
npm run check:data
```

`check:data` 只检查正式数据快照，会运行：

```bash
npm run check:data:eligibility
npm run check:data:rich
npm run check:data:layout
npm run check:data:catalog
npm run check:data:attribution
```

检查内容包括资格策略 fixture、中文摘要字数和占位符、中文题名、主题与 themeProvenance、作者与作品类型、HTTPS 来源和固定修订、布局坐标、语义关系 evidence、关系度数、manifest 覆盖率、catalog SHA-256，以及归属侧车的确定性一致性。

完整发布检查使用：

```bash
npm run check
```

它在 `check:data` 之上叠加 Vitest、TypeScript、`check:curated`（引力书线的真实 QID、无自环、去重、1,000 本覆盖、分布集中度和文案重复度）、`check:copy`（公开文案中的技术套话门禁）以及生产构建。CI 和提交前验收应以 `npm run check` 为准。

## 6. 旧版 Gutenberg 只保留为 legacy

仓库中仍保留早期 Project Gutenberg CSV 构建器，命令明确带有 legacy：

```bash
npm run build:data:legacy
npm run check:data:legacy
```

它只用于历史对照、脚本回归或离线实验，不进入正式中文 v2 星海，不产生正式 catalog-v2 的节点或关系，也不应在路演中宣称为当前作品的数据规模。正式 v2 的书目来源是 Wikidata + 中文维基百科，封面是可选的 Open Library URL；两条流水线的 schema、质量门槛和关系模型不同。

Project Gutenberg 的旧版来源说明可参考：

- [Project Gutenberg Offline Catalogs](https://www.gutenberg.org/ebooks/offline_catalogs.html)
- [官方 pg_catalog.csv.gz](https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz)
- [Project Gutenberg Terms of Use / License](https://www.gutenberg.org/policy/license)

即使运行 legacy 命令，也必须分别遵守 Project Gutenberg 的目录、文本、商标和再分发条款；项目不重新分发 Gutenberg 正文。不要把 legacy 目录中的 Type=Text 记录、旧版主题分组或旧版关系统计写进 README、演示页面或评审口径。

## 7. 字段级归属与发布责任

scripts/build-attribution.mjs 会从当前 catalog-v2 生成 public/data/ATTRIBUTION.json，并按作品 ID 稳定排序。每条记录保留：

- id、title；
- sourceUrl；
- 与 sourceUrl 同页的 wikipediaRevisionUrl；
- 对应 id 的 wikidataUrl；
- 有可靠封面时的 coverSourceUrl，没找到时为 null。

catalog 发生变化后必须重新生成并执行检查，不能手工编辑归属清单：

```powershell
node scripts/build-attribution.mjs --catalog public/data/catalog.json --output public/data/ATTRIBUTION.json
node scripts/build-attribution.mjs --check --catalog public/data/catalog.json --output public/data/ATTRIBUTION.json
```

DATA_LICENSE.md 进一步说明各字段的归属和再分发边界。对于未来真实图书馆数据，馆藏机构自己的 API、OPAC 导出、封面和借阅字段必须单独获得许可；当前 Demo 没有连接任何真实馆藏数据库，也不把外部开放数据等同于图书馆授权。

## 8. 对未来图书馆接入的约束

src/data/libraryAdapter.ts 的 normalizeLibraryRecord() 只做本地字段规范化，不会替图书馆取得授权或自动判断一条馆藏记录是否可以公开。接入真实馆藏时，至少需要重新确认：

1. 作品本体、版本、译本、副本和借阅事件的 ID 层级；
2. 题名、摘要、主题、作者和封面分别来自哪一项许可；
3. 哪些字段可以在馆外展示，哪些属于馆内或个人数据；
4. 语义关系是否需要馆员审核、按读者群体定制或提供反馈；
5. 对生成摘要、模型向量和读者轨迹的保存期限与删除机制。

适配器能把数据接到现有 Book 契约，不代表当前 Demo 已经完成真实馆藏接入。正式图书馆版本仍应保留来源回链、固定快照、关系证据和事实/推断边界。

## 参考文件

- README.md：产品叙事、路演路径、体验和运行命令。
- DATA_LICENSE.md：数据归属、许可证和 ATTRIBUTION.json 约定。
- scripts/lib/book-eligibility.mjs：共享 direct-P31 fail-closed 资格策略。
- scripts/build-rich-catalog.mjs：中文富书目构建器。
- scripts/build-semantic-layout.py：BGE + DensMAP 语义布局和关系生成器。
- scripts/assemble-v2-catalog.mjs：v2 合并与 manifest 生成器。
- scripts/check-rich-catalog.mjs、scripts/check-semantic-layout.mjs、scripts/check-v2-catalog.mjs：正式发布前检查器。
