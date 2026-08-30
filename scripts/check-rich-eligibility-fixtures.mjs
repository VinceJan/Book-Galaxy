#!/usr/bin/env node

import { evaluateWork, POLICY_HASH, POLICY_VERSION } from './lib/book-eligibility.mjs'

const claim = (id, rank = 'normal') => ({
  mainsnak: {
    snaktype: 'value',
    datavalue: { value: { 'entity-type': 'item', id }, type: 'wikibase-entityid' },
  },
  rank,
  id: `${id}$fixture`,
})

const literalClaim = (value, id) => ({
  mainsnak: { snaktype: 'value', datavalue: { value, type: 'string' } },
  rank: 'normal',
  id: `${id}$fixture`,
})

const work = (id, p31, extra = {}) => ({
  id,
  claims: {
    P31: p31.map((value) => typeof value === 'string' ? claim(value) : claim(value.id, value.rank)),
    ...extra,
  },
})

const bibliography = {
  P50: [claim('Q999001')],
  P577: [literalClaim({ time: '+2012-01-01T00:00:00Z' }, 'P577')],
  P407: [claim('Q999002')],
}

const fixtures = [
  ['Q105535081', work('Q105535081', ['Q24897257']), '', 'rejected'],
  ['Q107122801', work('Q107122801', ['Q620615', 'Q19967801', 'Q24897257']), '', 'rejected'],
  ['Q-mixed-allow-deny', work('Q-mixed-allow-deny', ['Q571', 'Q24897257']), '《混合条目》是一部小说。', 'rejected'],
  ['Q18989784', work('Q18989784', ['Q8274', 'Q63952888', 'Q14946528']), '', 'rejected'],
  ['Q850750', work('Q850750', ['Q7366', 'Q277759', 'Q8274', 'Q105543609']), '', 'rejected'],
  ['Q607112', work('Q607112', ['Q7725634'], bibliography), '《三体》是一部长篇小说。', 'accepted'],
  ['Q753894', work('Q753894', ['Q7725634'], bibliography), '《基地》（英语：Foundation），是美国作家艾萨克·阿西莫夫出版于1951年的科幻小说短篇集，“基地三部曲”的第一部（后来发展成“基地系列”）。这部短篇集里的故事先后发表于杂志。', 'accepted'],
  ['Q147787', work('Q147787', ['Q7725634'], bibliography), '《安娜·卡列尼娜》是一部长篇小说。', 'accepted'],
  ['Q151919', work('Q151919', ['Q47461344'], bibliography), '《活着》是余华创作的长篇小说。', 'accepted'],
  ['Q385530', work('Q385530', ['Q41795401']), '《藏文大藏经》是藏传佛教的经典集成，共收录甘珠尔与丹珠尔数千部译经。', 'rejected'],
  ['Q10524100', work('Q10524100', ['Q1191035', 'Q1980247']), '〈观世音菩萨普门品〉是《妙法莲华经》（七卷本）中的第二十五品，是节选自该经的观世音菩萨经典。', 'rejected'],
  ['Q85705758', work('Q85705758', ['Q47461344', 'Q1614239', 'Q179461']), '《正统道藏》是一部汇集大量道教经典及相关书籍的大丛书，收录许多不同典籍。', 'rejected'],
  ['Q215685', work('Q215685', ['Q179461', 'Q41795401']), '巴利三藏指上座部佛教用巴利语写成的三藏，是早期佛教经典的结集，分为经藏、律藏和论藏。', 'rejected'],
  ['Q138733', work('Q138733', ['Q1001051', 'Q210272', 'Q1261053', 'Q3331189']), '高丽大藏经是13世纪雕刻成的大藏经，共有六千余卷、五万余汉字，雕刻于八万余块木板上。', 'rejected'],
  ['Q10933436', work('Q10933436', ['Q1191035']), '《大乘庄严经论》是一部佛教经典。', 'accepted'],
  ['Q756604', work('Q756604', ['Q14406742', 'Q725377'], { P648: [literalClaim('OL5735175W', 'P648')] }), '《茉莉人生》是一部图像小说。', 'quarantine'],
  ['Q-deprecated', work('Q-deprecated', [{ id: 'Q24897257', rank: 'deprecated' }, 'Q7725634'], bibliography), '《保留的作品》是一部长篇小说。', 'accepted'],
  ['Q10786016', work('Q10786016', ['Q14204246', 'Q7725634']), '维基百科狂是一个维基百科项目页面，属于维基百科的项目空间而非独立书籍。', 'rejected'],
  ['Q110904767', work('Q110904767', ['Q7725310', 'Q2927074', 'Q7725634']), '后室是一个网络迷因及其衍生系列的共同世界，并非一部独立书籍。', 'rejected'],
  ['Q17439649', work('Q17439649', ['Q171', 'Q7725310', 'Q7725634']), 'SCP基金会是一个由用户共同创作的协作写作 wiki 项目，不是单一书级作品。', 'rejected'],
  ['Q1141990', work('Q1141990', ['Q179461', 'Q7725634', 'Q1614239']), '《道藏》是一部汇集大量道教经典及相关书籍的大丛书，包含许多不同典籍。', 'rejected'],
  ['Q34990', work('Q34990', ['Q179461', 'Q7725634']), '《妥拉》可指犹太教的核心经书传统，既包括书面摩西五经，也包括口头律法与相关教导。', 'rejected'],
  ['Q174361', work('Q174361', ['Q179461', 'Q2986441', 'Q61963396'], { P50: [claim('Q146921')], P407: [claim('Q50868')] }), '《死者之书》是一种古埃及墓葬文书，写在莎草纸上；古埃及人的死者之书几乎都是独一无二的，因为内容因人而异。', 'rejected'],
  ['Q1762323', work('Q1762323', ['Q179461', 'Q7725634'], { P50: [claim('Q2095353')] }), '《引支勒》首句只是福音的阿拉伯语名称；条目讨论一种已失传且解释不一的启示概念，并非可核验的单一现存文本。', 'rejected'],
  ['Q11411329', work('Q11411329', ['Q7725634'], bibliography), '古池蛙跃溅水声是松尾芭蕉的一首俳句。', 'quarantine'],
  ['Q3647427', work('Q3647427', ['Q7725634'], bibliography), '《烧毁的诺顿》是《四个四重奏》中的第一首诗。', 'quarantine'],
  ['Q3704447', work('Q3704447', ['Q7725634']), '推理小说十诫是一组写作原则。', 'quarantine'],
  ['Q22738', work('Q22738', ['Q7725634'], bibliography), '洞穴寓言是柏拉图著作中的一则寓言故事。', 'quarantine'],
  ['Q17059490', work('Q17059490', ['Q7725634'], bibliography), '某某体是一种文学类型和写作规则。', 'quarantine'],
  ['Q-book-metadata-only', work('Q-book-metadata-only', ['Q7725634'], bibliography), '《基地与地球》由艾萨克·阿西莫夫创作，延续基地宇宙的故事。', 'quarantine'],
  ['Q-book-openlibrary', work('Q-book-openlibrary', ['Q7725634'], { ...bibliography, P648: [literalClaim('OL123W', 'P648')] }), '《未命名作品》围绕一座海边城市展开。', 'quarantine'],
  ['Q-base-and-earth', work('Q-base-and-earth', ['Q7725634'], bibliography), '《基地与地球》是美国作家艾萨克·阿西莫夫创作的科幻小说。', 'accepted'],
  ['Q-the-innocent-age', work('Q-the-innocent-age', ['Q7725634'], bibliography), '《纯真年代》是伊迪丝·华顿创作的一部小说。', 'accepted'],
  ['Q-collection', work('Q-collection', ['Q7725634'], bibliography), '《呐喊》是鲁迅的一部短篇小说结集。', 'accepted'],
  ['Q178869', work('Q178869', ['Q7725634'], bibliography), '《百年孤独》是哥伦比亚作家马尔克斯的作品，是魔幻现实主义的典范。作者也因此书获得诺贝尔文学奖。《百年孤独》于1967年出版。小说以虚构城镇马孔多及布恩迪亚家族的兴衰为核心。', 'accepted'],
  ['Q10888453', work('Q10888453', ['Q7725634'], bibliography), '《倾城之恋》是作家张爱玲创作的一篇短篇小说作品。', 'quarantine'],
  ['Q1097462', work('Q1097462', ['Q7725634'], bibliography), '《小径分岔的花园》是一篇短篇小说。', 'quarantine'],
  ['Q1087628', work('Q1087628', ['Q7725634'], bibliography), '《希腊古瓮颂》是英国诗人济慈的一首诗作。', 'quarantine'],
  ['Q113624737', work('Q113624737', ['Q7725634'], bibliography), '《论住宅问题》是恩格斯写的一篇论文。', 'quarantine'],
  ['Q1530590', work('Q1530590', ['Q7725634'], bibliography), '《学术作为一种志业》是韦伯发表的一篇演讲。', 'quarantine'],
  ['Q526227', work('Q526227', ['Q7725634'], bibliography), '《猎象记》是乔治·奥威尔写的一篇文章。', 'quarantine'],
  ['Q55616783', work('Q55616783', ['Q7725634'], bibliography), '这是一篇具有影响力的讲话。', 'quarantine'],
  ['Q10864465', work('Q10864465', ['Q7725634'], bibliography), '《七万言书》是递交给中国共产党的藏区调查报告。', 'quarantine'],
  ['Q277072', work('Q277072', ['Q7725634'], bibliography), '《某某公约》是一项国际公约。', 'quarantine'],
  ['Q1212384', work('Q1212384', ['Q7725634'], bibliography), '《星之彩》是一本由美国作家洛夫克拉夫特撰写的恐怖短篇小说。', 'quarantine'],
  ['Q14008449', work('Q14008449', ['Q7725634'], bibliography), '《冬天的梦》是一部短篇小说，被收录到作者的短篇小说集。', 'quarantine'],
  ['Q1763860', work('Q1763860', ['Q7725634'], bibliography), '《装在套子里的人》是契诃夫发表的一篇批判现实主义短篇小说。', 'quarantine'],
  ['Q2334223', work('Q2334223', ['Q7725634'], bibliography), '《憾事一桩》是爱尔兰作家乔伊斯的短篇小说，收录于《都柏林人》。', 'quarantine'],
  ['Q2977500', work('Q2977500', ['Q7725634'], bibliography), '《为埃斯米而作——既有爱也有污秽凄苦》（英语：For Esmé—with Love and Squalor）是美国作家J.D.塞林格创作的短篇小说。小说以一名中士为主角。', 'quarantine'],
  ['Q43361', work('Q43361', ['Q7725634'], bibliography), '《哈利·波特与魔法石》（英语：Harry Potter and the Philosopher’s Stone）是哈利·波特系列小说的第一集，由英国作家J.K.罗琳创作。剧情讲述一位小巫师进入魔法学校的经历。', 'accepted'],
  ['Q2310317', work('Q2310317', ['Q1001051']), '大悲咒又称大悲心陀罗尼，是大乘佛教《大悲心陀罗尼经》中的咒文，汉传共有八十四句。', 'quarantine'],
  ['Q85592120', work('Q85592120', ['Q1001051', 'Q131510']), '《观音灵感真言》是观世音菩萨的咒语，为汉传佛教十小咒之一。', 'rejected'],
  ['Q3298805', work('Q3298805', ['Q7725634'], bibliography), '智慧语是由教会出版书籍《教义和圣约》中的一个章节，该名称也是该段经文中健康规章的名称。', 'quarantine'],
  ['Q55696966', work('Q55696966', ['Q7725634'], bibliography), '《关于正确处理人民内部矛盾的问题》是毛泽东于1957年发表的论文，是一篇重要文献。', 'quarantine'],
  ['Q1074155', work('Q1074155', ['Q7725634'], bibliography), '《环舞》是阿西莫夫创作的一篇短篇科幻小说，后来收录于《我，机器人》。', 'quarantine'],
  ['Q372968', work('Q372968', ['Q7725634'], bibliography), '《罗比》是阿西莫夫创作的一篇短篇科幻小说，最初发表于杂志。', 'quarantine'],
  ['Q235131', work('Q235131', ['Q179461']), '穆斯林相信伊斯兰教圣书是真主的著作，祂把这些圣书传授给多位先知。', 'quarantine'],
  ['Q912549', work('Q912549', ['Q179461']), '《但以理书》补编是指原文本中无法找到的三个篇章，这三章收录于七十士译本。', 'quarantine'],
  ['Q5599006', work('Q5599006', ['Q7725634'], bibliography), '《伟大会话》是西方正典作者们对前辈著作提及和隐喻的特征。同样的名称也用于一套名著丛书。', 'quarantine'],
  ['Q27903111', work('Q27903111', ['Q7725634'], bibliography), '《手中纸，心中爱》为刘宇昆发表的一篇科幻小说，最初发表于杂志。', 'quarantine'],
  ['Q27968076', work('Q27968076', ['Q7725634'], bibliography), '《纪录片：终结历史之人》是刘宇昆发表的一篇科幻小说，最初发表在短篇小说集中。', 'quarantine'],
  ['Q17210282', work('Q17210282', ['Q7725634'], bibliography), '《教场》是以警察学校为场景的警察小说系列，已有短篇集四册和长篇一册。', 'quarantine'],
  ['Q3127227', work('Q3127227', ['Q7725634'], bibliography), '《哈普沃兹16，1924》刊于杂志，作者尝试将其再版但没有成功。', 'rejected'],
  ['Q3761739', work('Q3761739', ['Q7725634'], bibliography), '《大逃杀》是一部长篇小说。', 'rejected'],
  ['Q597697', work('Q597697', ['Q179461']), '《西藏度亡经》是一部传统宗教经典。', 'rejected'],
  ['Q4837410', work('Q4837410', ['Q7725634'], bibliography), '《卡罗的巴巴》是一部人类学著作。', 'rejected'],
  ['Q1321432', work('Q1321432', ['Q179461']), '三藏是佛教术语，指佛教经典的分类法。', 'rejected'],
  ['Q201410', work('Q201410', ['Q179461']), '次经是由几部不同著作组成的集合。', 'rejected'],
  ['Q216383', work('Q216383', ['Q179461']), '先知书是《希伯来圣经》三部分中的第二部分。', 'rejected'],
  ['Q2655574', work('Q2655574', ['Q47461344'], bibliography), '《濒死的地球》是杰克·万斯创作的系列奇幻小说。', 'rejected'],
  ['Q2261631', work('Q2261631', ['Q108329152']), '《尼可波勒三部曲》是一系列图像小说合集，包含三部作品。', 'rejected'],
  ['Q3086228', work('Q3086228', ['Q179461']), '历史书是《圣经》的一部分，包括以下十二卷书。', 'rejected'],
  ['Q3224748', work('Q3224748', ['Q7725634'], bibliography), '《怪物》是一篇中篇小说，首次发表于杂志，后来收入故事集。', 'rejected'],
  ['Q4212557', work('Q4212557', ['Q179461']), '景教经典是景教所译经书与典籍的集合，原有多部，现存六部并分别列名。', 'rejected'],
  ['Q322188', work('Q322188', ['Q7725634'], bibliography), '《名字古怪的小矮人儿》是一则童话，收录于故事集中的第55则故事。', 'quarantine'],
  ['Q28452645', work('Q28452645', ['Q7725634'], bibliography), '《肿瘤》是美国作家约翰·基斯咸所写的短篇故事。', 'quarantine'],
  ['Q10949824', work('Q10949824', ['Q179461']), '被称为宣元至本经的敦煌文书共有两件，一为《大秦景教宣元本经》，一为《大秦景教宣元至本经》。', 'quarantine'],
  ['Q4502013', work('Q4502013', ['Q179461']), '黄庭经指《太上黄庭内景玉经》和《太上黄庭外景玉经》，是两部不同道教经典的合称。', 'quarantine'],
  ['Q-invalid-date', work('Q-invalid-date', ['Q7725634'], { ...bibliography, P577: [literalClaim({ time: '+1812097678-00-00T00:00:00Z' }, 'P577')] }), '《异常日期》是一部长篇小说。', 'quarantine'],
  ['Q53925697', work('Q53925697', ['Q104213567', 'Q7725634'], bibliography), '《在异世界开拓第二人生》是一部小说。', 'quarantine'],
  ['Q6778594', work('Q6778594', ['Q13406463', 'Q7725634'], bibliography), '《马克思恩格斯文集》是一部文集。', 'rejected'],
]

const entityMap = Object.fromEntries([
  ['Q7725634', '文学作品'], ['Q47461344', '书面作品'], ['Q41795401', '宗教文本'], ['Q1191035', '经书'],
  ['Q14406742', '图像小说系列'], ['Q725377', '图像小说'], ['Q24897257', '网站'], ['Q620615', '漫画杂志'],
  ['Q19967801', '漫画平台'], ['Q8274', '动画电视系列'], ['Q63952888', '虚构角色'], ['Q14946528', '动画系列'],
  ['Q277759', '系列'], ['Q105543609', '电视动画'], ['Q7366', '虚构作品'],
  ['Q14204246', '维基媒体项目页面'], ['Q7725310', '系列创意作品'], ['Q2927074', '网络迷因'], ['Q171', 'wiki'],
  ['Q104213567', '日本轻小说系列'], ['Q13406463', '维基媒体列表条目'], ['Q131510', '曼怛罗'], ['Q1980247', '章节'],
].map(([id, label]) => [id, { id, labels: { zh: { value: label } } }]))

const results = fixtures.map(([id, entity, intro, expected]) => {
  const evaluation = evaluateWork({ work: entity, entityMap, intro, hasOpenLibrary: Boolean(entity.claims.P648) })
  return { id, expected, actual: evaluation.status, ruleId: evaluation.ruleId, pass: evaluation.status === expected }
})
const failures = results.filter((result) => !result.pass)
if (failures.length) {
  console.error(JSON.stringify({ ok: false, policyVersion: POLICY_VERSION, policyHash: POLICY_HASH, failures, results }, null, 2))
  process.exitCode = 1
} else {
  console.log(JSON.stringify({ ok: true, policyVersion: POLICY_VERSION, policyHash: POLICY_HASH, fixtures: results.length, results }, null, 2))
}
