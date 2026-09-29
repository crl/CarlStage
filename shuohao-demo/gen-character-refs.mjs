// 生成 character-refs 资产与提示词方案（暗黑反转《辛德瑞拉》8 个角色）
// 复用 character-refs 技能自带的 buildPrompt / DEFAULT_LOOK，保证提示词与技能内部一致。
// 无图像后端：只交付 asset.json（已含造型与画风快照，配置后端后即可 gen）+ 提示词方案文档。
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SKILL = 'C:/Users/Carl/.workbuddy/skills/character-refs/scripts/';
const D = 'C:/Users/Carl/WorkBuddy/2026-09-29-10-00-00/shuohao-demo/辛德瑞拉';
const OUT = join(D, 'character-refs');

const core = await import(pathToFileURL(SKILL + 'core.mjs').href);
const look = core.DEFAULT_LOOK; // 默认动漫画风（drawn）

// 角色分层描述：identity / face / hair / build / top / bottom / details
// 文本均从 cast.json 的 appearance + image.prompt 提炼，en 进提示词，text 给人看。
const CHARS = {
  '辛德瑞拉': {
    age: 18, gender: 'female',
    identity: ['a slender eighteen-year-old European woman from a fairy-tale kingdom, an oppressed stepdaughter who carries herself with quiet grace', '约十八岁的欧洲童话王国少女，受压迫的继女，举止优雅隐忍'],
    face: ['a gentle oval face with large soft golden-brown eyes that hold a faint sorrow, fine delicate features', '柔和鹅蛋脸，大眼温柔带愁，五官精致'],
    hair: ['long soft golden-blonde hair falling in loose waves past the shoulders', '柔金长发，松散波浪垂至肩下'],
    build: ['a slender, graceful figure of medium height', '身形纤细优雅，中等身高'],
    top: ['the fitted pale-blue bodice of a ball gown with delicate silver embroidery and thin shoulder straps', '浅蓝舞会礼裙上身，缀银线刺绣，细肩带'],
    bottom: ['the long flowing pale-blue skirt of the ball gown with a silver-embroidered hem', '浅蓝舞会礼裙长摆，下摆缀银线刺绣'],
    details: [
      { slot: 'custom', id: 'crystal-shoe', part: 'feet', en: 'a single crystal slipper on one foot while the other foot stays bare', text: '一只脚穿水晶鞋、另一只赤足' },
      { slot: 'hair', en: 'soft golden waves gathered with a small ribbon at the side', text: '柔金波浪发，侧边缀小缎带' },
    ],
  },
  '王子': {
    age: 22, gender: 'male',
    identity: ['a tall and noble twenty-two-year-old European prince, the kingdom’s heir', '约二十二岁的欧洲年轻王子，王国继承人，身形挺拔高贵'],
    face: ['a handsome face with earnest warm dark eyes and soft short dark hair', '俊朗面容，眼神诚挚温热，柔黑短发'],
    hair: ['short soft dark hair, neatly kept', '柔黑短发，打理整齐'],
    build: ['a tall, upright and well-built frame', '身形挺拔、匀称'],
    top: ['a royal military dress uniform jacket with epaulettes', '带肩饰的王室军礼服上衣'],
    bottom: ['matching uniform trousers worn with a ceremonial sash and a slender sword at the side', '配套军礼裤，佩绶带与腰侧细剑'],
    details: [
      { slot: 'custom', id: 'sash', part: 'body', en: 'a ceremonial sash draped across the chest', text: '横过胸前的仪式绶带' },
      { slot: 'custom', id: 'sword', part: 'body', en: 'a slender dress sword at the side', text: '腰侧佩细剑' },
    ],
  },
  '后母': {
    age: 45, gender: 'female',
    identity: ['a stern forty-five-year-old European matron, the mistress of the household', '约四十五岁的欧洲中年贵妇，宅邸女主人，神情严厉'],
    face: ['a sharp-featured face with thin pressed lips and cold eyes', '五官刻薄，唇线紧抿，眼神冷硬'],
    hair: ['hair pinned in a tight severe bun', '发髻紧绾，一丝不苟'],
    build: ['a rigid, corseted figure of medium build', '身形紧束，体态刻板'],
    top: ['a dark high-necked long gown', '暗色高领长裙'],
    bottom: ['the long skirt of the dark austere gown', '暗色肃穆长裙的下摆'],
    details: [
      { slot: 'hair', en: 'a tight severe bun with not a strand out of place', text: '紧绾的发髻，一丝不乱' },
      { slot: 'custom', id: 'ring', part: 'hands', en: 'a heavy signet ring on one finger', text: '手指上一枚厚实印章戒指' },
    ],
  },
  '大姐': {
    age: 20, gender: 'female',
    identity: ['a vain twenty-year-old European noblewoman, slightly taller and competitive', '约二十岁的欧洲贵族少女，虚荣好胜，身量略高'],
    face: ['a pretty face with a jealous set to the mouth', '俏丽面容，嘴角因不服而绷着'],
    hair: ['elaborate curled hair', '发卷夸张'],
    build: ['a slightly taller, slender frame', '身量略高，身形纤细'],
    top: ['an ornate jewel-toned gown with excessive frills', '繁复珠宝色长裙，缀过多荷叶边'],
    bottom: ['the long ornate skirt of the jewel-toned gown', '珠宝色长裙的长摆'],
    details: [
      { slot: 'hair', en: 'heavy elaborate curls piled high', text: '夸张的厚重卷发' },
      { slot: 'custom', id: 'necklace', part: 'neck', en: 'an ostentatious jeweled necklace', text: '张扬的珠宝项链' },
    ],
  },
  '二姐': {
    age: 18, gender: 'female',
    identity: ['an eighteen-year-old European noblewoman, slightly rounder and flustered', '约十八岁的欧洲贵族少女，身形略圆，神情慌张'],
    face: ['a rounder face with a flustered expression', '略圆的脸，神情慌张'],
    hair: ['hair dressed with fussy small hairpins', '发间别细碎小簪'],
    build: ['a slightly rounder, smaller frame', '身形略圆，娇小'],
    top: ['an ornate gown with finer scattered ornaments', '华丽长裙，缀细碎小饰'],
    bottom: ['the long ornate skirt of the gown', '华丽长裙的长摆'],
    details: [
      { slot: 'custom', id: 'hairpin', part: 'hair', en: 'small fussy hairpins scattered through the hair', text: '发间细碎小簪' },
      { slot: 'custom', id: 'bracelet', part: 'hands', en: 'a delicate bracelet on the wrist', text: '腕间细巧手镯' },
    ],
  },
  '仙女': {
    age: 28, gender: 'female',
    identity: ['an ageless ethereal European woman, a fairy benefactor touched by grace', '不老不死的欧洲神话女性，蒙受神恩的施助者'],
    face: ['a kind luminous face with soft silver hair and gentle eyes', '眼含慈光，柔银长发，神情慈爱'],
    hair: ['long soft silver hair', '柔银长发'],
    build: ['a willowy, light-bearing figure', '身形苗条，泛着微光'],
    top: ['a gown of layered translucent pale fabric with a faint starlight shimmer', '层叠半透淡色织物，泛细微星光'],
    bottom: ['the long flowing hem of the starlit gown', '星光纱裙的长摆'],
    details: [
      { slot: 'hair', en: 'soft silver hair drifting as if in a gentle breeze', text: '柔银长发，如沐微风' },
      { slot: 'custom', id: 'wand', part: 'hands', en: 'a slender wand with a glowing tip', text: '手持发光细杖' },
    ],
  },
  '大臣': {
    age: 50, gender: 'male',
    identity: ['a composed fifty-year-old European royal court official', '约五十岁的欧洲朝臣，持重方正'],
    face: ['a neutral authoritative face with a neat short beard', '神情持重，短须整齐'],
    hair: ['short neat hair with a trimmed beard', '短发整齐，须发修剪利落'],
    build: ['a sturdy, formal bearing', '体态持重，举止方正'],
    top: ['a dark formal court coat with a high collar', '高领深色朝服'],
    bottom: ['dark formal court trousers worn with a medal sash', '深色朝裤，配勋章绶带'],
    details: [
      { slot: 'custom', id: 'medal', part: 'body', en: 'a medal sash across the chest', text: '胸前勋章绶带' },
      { slot: 'custom', id: 'cushion', part: 'hands', en: 'a pair of velvet cushions carried in the hands', text: '手托一对天鹅绒垫' },
    ],
  },
  '国王': {
    age: 60, gender: 'male',
    identity: ['a weary but regal sixty-year-old European king', '约六十岁的欧洲年迈君王，仪态威重'],
    face: ['a weathered face with weary but commanding eyes and a long silver beard', '面容疲惫而威严，银白长须'],
    hair: ['a long silver beard and short silver hair', '银白长须，短银发'],
    build: ['a heavy, authoritative frame', '体态厚重，威严'],
    top: ['heavy royal robes with ermine trim', '厚重貂皮镶边王袍'],
    bottom: ['the long train of the ermine-trimmed royal robe', '貂皮镶边王袍的长摆'],
    details: [
      { slot: 'custom', id: 'crown', part: 'hair', en: 'a jeweled crown resting on the head', text: '头戴宝石王冠' },
      { slot: 'custom', id: 'ermine', part: 'body', en: 'thick ermine fur trim along the robe', text: '王袍厚重貂皮镶边' },
    ],
  },
};

const VIEWS = ['front-full', 'face-front', 'side-full', 'back-full'];
const ST = 'stated';
const assets = [];
const scheme = []; // {name, rows:[{view,ratio,text,negative}]}

for (const [name, L] of Object.entries(CHARS)) {
  const asset = {
    name,
    source: '灰姑娘·殉葬（暗黑反转）',
    lang: 'zh',
    layers: {
      identity: { age: L.age, gender: L.gender, en: L.identity[0], text: L.identity[1], source: ST },
      face: { en: L.face[0], text: L.face[1], source: ST },
      hair: { en: L.hair[0], text: L.hair[1], source: ST },
      build: { en: L.build[0], text: L.build[1], source: ST },
    },
    outfits: {
      default: {
        label: '常态',
        top: { en: L.top[0], text: L.top[1], source: ST },
        bottom: { en: L.bottom[0], text: L.bottom[1], source: ST },
        details: (L.details || []).map((d) => ({ ...d, source: ST })),
        overrides: {},
        look: { ...look },
        views: {}, // 无后端：暂不出图，配置后端后 gen 即按这些分层出图
        upgrades: [],
      },
    },
  };

  // 用技能自带 buildPrompt 产出每个视图的提示词方案
  const rows = [];
  for (const v of VIEWS) {
    const p = core.buildPrompt(asset, 'default', v, look);
    rows.push({ view: v, ratio: p.ratio, text: p.text, negative: p.negative });
  }
  scheme.push({ name, rows });

  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'asset.json'), JSON.stringify(asset, null, 2), 'utf8');
  assets.push({ asset, assetDir: dir });
}

writeFileSync(join(OUT, '_scheme.json'), JSON.stringify(scheme, null, 2), 'utf8');
console.log(`✓ 已生成 ${assets.length} 份 asset.json，画风：${look.label?.zh ?? look.id}`);
console.log('  下一步：运行技能 render 产出 character-refs-report.html；另用本脚本生成的 _scheme.json 产出提示词方案文档。');
