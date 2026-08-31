/**
 * 三条为体验预编排的“黄金航线”。
 * relationId 与 curatedRelations.ts 中 rel() 生成的稳定 ID 对齐，
 * 第一步没有关系 ID，表示从用户选择的书开始。
 */
export interface DemoJourneyStep {
  bookId: string;
  relationId?: string;
  arrival: string;
  prompt?: string;
  reveal?: string;
}

export interface DemoJourney {
  id: string;
  title: string;
  subtitle: string;
  mode: string;
  entryBookId: string;
  invitation: string;
  steps: DemoJourneyStep[];
  closingLine: string;
  bookIds: string[];
}

export const demoJourneys: DemoJourney[] = [
  {
    id: "civilization-learns-to-fear",
    title: "文明如何学会害怕",
    subtitle: "从宇宙的黑暗，漂回一张旧奏疏",
    mode: "远距偏航",
    entryBookId: "three-body",
    invitation: "带我去最远、但仍然说得通的地方",
    steps: [
      {
        bookId: "three-body",
        arrival: "你从一颗收到回声的行星出发。",
        prompt: "如果文明的敌人不是另一个文明，而是时间本身？",
      },
      {
        bookId: "foundation",
        relationId: "three-body--foundation",
        arrival: "航迹被文明周期的引力捕获。",
        reveal: "宇宙恐惧被折叠成历史模型：先看见帝国如何死去。",
      },
      {
        bookId: "wanli-fifteen-years",
        relationId: "foundation--wanli-fifteen-years",
        arrival: "宏大的曲线忽然坠入一份旧奏疏。",
        reveal: "真正让文明转向的，可能不是末日，而是一处没人修补的细节。",
      },
      {
        bookId: "discipline-and-punish",
        relationId: "wanli-fifteen-years--discipline-and-punish",
        arrival: "礼制的影子变成了看不见的监牢。",
        reveal: "制度不必发出命令，身体也会学会自我监视。",
      },
      {
        bookId: "imagined-communities",
        relationId: "discipline-and-punish--imagined-communities",
        arrival: "监牢外出现一张地图，陌生人开始互称同胞。",
        reveal: "共同体既可能由墙制造，也可能由一个共同的想象制造。",
      },
      {
        bookId: "guns-germs-and-steel",
        relationId: "imagined-communities--guns-germs-and-steel",
        arrival: "星图的经线被地理的暗流悄悄扭曲。",
        reveal: "历史的座次不只由信念决定，也由作物、病菌和地形投下的骰子决定。",
      },
      {
        bookId: "republic",
        relationId: "guns-germs-and-steel--republic",
        arrival: "最远的一跳回到一间关于正义的洞穴。",
        reveal: "当我们问‘谁赢得了历史’，也该问‘怎样的生活才值得赢得’。",
      },
    ],
    closingLine: "你以为自己在探索宇宙，最后发现走完的是一条关于共同生活的路。",
    bookIds: [
      "three-body",
      "foundation",
      "wanli-fifteen-years",
      "discipline-and-punish",
      "imagined-communities",
      "guns-germs-and-steel",
      "republic",
    ],
  },
  {
    id: "marriage-after-the-mirror",
    title: "婚姻的另一面",
    subtitle: "一条从爱情出发、穿过凝视的航线",
    mode: "关系考古",
    entryBookId: "anna-karenina",
    invitation: "沿着同一种伤口，找到它的反面",
    steps: [
      {
        bookId: "anna-karenina",
        arrival: "你从一段无法被体面容纳的爱情出发。",
        prompt: "如果悲剧不只来自错误的选择，也来自没有选择的世界？",
      },
      {
        bookId: "madame-bovary",
        relationId: "anna-karenina--madame-bovary",
        arrival: "两条轨道在一间乡镇卧室交叠。",
        reveal: "安娜和艾玛都在婚姻的窄门里追问爱情，只是一个驶向铁轨，一个沉入债务。",
      },
      {
        bookId: "golden-cangue",
        relationId: "madame-bovary--golden-cangue",
        arrival: "浪漫的火熄灭后，留下了一把金色的锁。",
        reveal: "当逃离失败，受过的伤有时会被铸成下一代的牢笼。",
      },
      {
        bookId: "second-sex",
        relationId: "golden-cangue--second-sex",
        arrival: "故事的暗处亮起一盏冷静的阅读灯。",
        reveal: "小说让人看见一个女人如何变形，理论追问这种变形为何总被叫作天性。",
      },
      {
        bookId: "discipline-and-punish",
        relationId: "second-sex--discipline-and-punish",
        arrival: "身体之外出现了更大的规训建筑。",
        reveal: "婚姻不是唯一的围墙；学校、工厂和社会目光也在训练‘合适的人’。",
      },
      {
        bookId: "republic",
        relationId: "discipline-and-punish--republic",
        arrival: "镜子翻到背面，露出一座自称正义的城市。",
        reveal: "谁有资格定义理想生活，决定了谁必须在理想之外生活。",
      },
    ],
    closingLine: "你寻找一本关于爱情的书，最后撞见了一个关于谁能自由生活的问题。",
    bookIds: [
      "anna-karenina",
      "madame-bovary",
      "golden-cangue",
      "second-sex",
      "discipline-and-punish",
      "republic",
    ],
  },
  {
    id: "after-suffering-the-river-remembers",
    title: "苦难之后，河流仍然记得",
    subtitle: "从马孔多的遗忘，漂到一个普通人的晚餐",
    mode: "余烬漫游",
    entryBookId: "one-hundred-years-solitude",
    invitation: "让我遇见一本不会主动搜索、但此刻值得遇见的书",
    steps: [
      {
        bookId: "one-hundred-years-solitude",
        arrival: "你从一座反复遗忘自己的小镇出发。",
        prompt: "如果一个家族记住历史的方式，不是保存档案而是继续生活？",
      },
      {
        bookId: "les-miserables",
        relationId: "one-hundred-years-solitude--les-miserables",
        arrival: "星云裂开，远处亮起一场街垒的火。",
        reveal: "马孔多与巴黎都在对抗遗忘：一个反复失去名字，一个试图替无名者讨回名字。",
      },
      {
        bookId: "to-live",
        relationId: "les-miserables--to-live",
        arrival: "革命的火焰退远，只剩一块田和一个老人。",
        reveal: "宏大的正义落到日常之后，救赎有时只是失去一切仍愿意照看一头牛。",
      },
      {
        bookId: "xu-sanguan",
        relationId: "to-live--xu-sanguan",
        arrival: "另一位父亲在身体里打开一间当铺。",
        reveal: "卖掉的不是血肉，而是一个人不肯倒下的时间。",
      },
      {
        bookId: "ordinary-world",
        relationId: "xu-sanguan--ordinary-world",
        arrival: "小城的灯熄灭，远处煤窑亮起。",
        reveal: "同一副身体既能救急，也能把普通的明天一点点托起来。",
      },
      {
        bookId: "right-bank-ergun",
        relationId: "ordinary-world--right-bank-ergun",
        arrival: "现代化的道路忽然转向一条北方河流。",
        reveal: "一个故事走向城市，一个故事退回森林；进步也应该记得询问谁被留在岸上。",
      },
      {
        bookId: "old-man-and-sea",
        relationId: "right-bank-ergun--old-man-and-sea",
        arrival: "森林的雾散去，海面只剩一个人的桨声。",
        reveal: "自然不是背景，也不是敌人；它让孤独拥有了可以凝视的形状。",
      },
      {
        bookId: "mans-search-for-meaning",
        relationId: "old-man-and-sea--mans-search-for-meaning",
        arrival: "航线停在一处没有观众的内心。",
        reveal: "意义首先是一件无人见证，仍然愿意做完的事。",
      },
    ],
    closingLine: "你穿过了百年的孤独，最后留下的不是答案，而是继续为某个人点灯的能力。",
    bookIds: [
      "one-hundred-years-solitude",
      "les-miserables",
      "to-live",
      "xu-sanguan",
      "ordinary-world",
      "right-bank-ergun",
      "old-man-and-sea",
      "mans-search-for-meaning",
    ],
  },
];

export const curatedDemoJourneys = demoJourneys;

export default demoJourneys;
