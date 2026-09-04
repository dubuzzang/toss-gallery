// 서버가 어느 지역에 배포되든 "자정"은 한국시간 기준이 되도록 고정
process.env.TZ = 'Asia/Seoul';

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const cloudflareStorage = require('./cloudflare/storage');
const IS_CLOUDFLARE = process.env.CLOUDFLARE_RUNTIME === 'true';
const CLOUDFLARE_ASSETS = IS_CLOUDFLARE ? require('./cloudflare/runtime.mjs') : {};
const ADMIN_HTML = CLOUDFLARE_ASSETS.adminHtml || null;
const FRONT_HTML = CLOUDFLARE_ASSETS.frontHtml || null;

const app = express();
app.use(express.json());

// 레일웨이에 "Volume"을 /data 경로로 연결해두면 재배포해도 데이터가 안 사라져요.
// 볼륨이 없으면(로컬 테스트 등) 그냥 프로젝트 폴더에 저장해요.
const DATA_DIR = cloudflareStorage.isCloudflare ? '/tmp' : (fs.existsSync('/data') ? '/data' : __dirname);

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!cloudflareStorage.isCloudflare && !fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: cloudflareStorage.isCloudflare ? multer.memoryStorage() : multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, 'og-' + Date.now() + ext);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 } // 8MB
});

// 업로드된 사진 파일만 공개로 서빙 (관리자/프론트 페이지 파일은 여기 없음)
if (!cloudflareStorage.isCloudflare) {
  app.use('/uploads', express.static(UPLOAD_DIR));
  app.use('/assets', express.static(path.join(__dirname, 'assets')));
}

const DATA_FILE = path.join(DATA_DIR, 'data.json');
const OG_FILE = path.join(DATA_DIR, 'og.json');

// ---- 관리자 비밀번호 보호 ----
// Railway의 Variables 탭에서 ADMIN_USER, ADMIN_PASSWORD를 꼭 원하는 값으로 설정해주세요.
// 설정하지 않으면 아래 기본값(admin / toss1234)으로 동작하니, 배포 후 꼭 바꿔주세요.
const ADMIN_USER = cloudflareStorage.getBinding('ADMIN_USER', process.env.ADMIN_USER) || 'admin';
const ADMIN_PASSWORD = cloudflareStorage.getBinding('ADMIN_PASSWORD', process.env.ADMIN_PASSWORD) || 'toss1234';

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Basic ') ? header.slice(6) : '';
  let decoded = '';
  try { decoded = Buffer.from(token, 'base64').toString('utf-8'); } catch (e) { /* noop */ }
  const sep = decoded.indexOf(':');
  const user = sep === -1 ? decoded : decoded.slice(0, sep);
  const pass = sep === -1 ? '' : decoded.slice(sep + 1);

  if (user === ADMIN_USER && pass === ADMIN_PASSWORD) return next();

  res.set('WWW-Authenticate', 'Basic realm="Admin Only"');
  return res.status(401).send('관리자 인증이 필요해요.');
}

function formatDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// resetTime(예: "00:00", "09:00")을 기준으로 "오늘"이 언제 바뀌는지 계산.
// 지금 시각이 resetTime 이전이면 아직 어제(전날) 몫으로 취급.
function dealDateStr(resetTime) {
  const [rh, rm] = (resetTime || '00:00').split(':').map(n => parseInt(n, 10) || 0);
  const now = new Date();
  const resetToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), rh, rm, 0, 0);
  if (now < resetToday) {
    const prev = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return formatDateStr(prev);
  }
  return formatDateStr(now);
}

function readData() {
  return cloudflareStorage.readJson('data', DATA_FILE, []);
}

function writeData(products) {
  cloudflareStorage.writeJson('data', DATA_FILE, products);
}

const DEFAULT_OG = {
  title: '쇼핑 레이더 오늘의 특가 갤러리',
  description: '토스쇼핑 활동으로 수수료를 받습니다',
  badge: '토스쇼핑 활동으로 수수료를 받습니다',
  image: '',
  icon: '',
  resetTime: '00:00'
};

function readOg() {
  return { ...DEFAULT_OG, ...cloudflareStorage.readJson('og', OG_FILE, {}) };
}

function writeOg(og) {
  cloudflareStorage.writeJson('og', OG_FILE, og);
}

function escapeAttrStr(str) {
  return String(str || '').replace(/"/g, '&quot;');
}

function escapeHtmlStr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---- 상품 API ----

app.use(cloudflareStorage.jsonMiddleware({ data: [], og: DEFAULT_OG }));

app.get('/uploads/:filename', async (req, res, next) => {
  if (!cloudflareStorage.isCloudflare) return next();
  if (!/^og-[0-9]+\.[a-zA-Z0-9]+$/.test(req.params.filename)) return res.status(400).send('잘못된 파일 이름이에요.');
  const object = await cloudflareStorage.getObject(`uploads/${req.params.filename}`);
  if (!object) return res.status(404).send('파일을 찾을 수 없어요.');
  res.setHeader('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(Buffer.from(await object.arrayBuffer()));
});

// 전체 상품 목록 (관리자 전용 - 오늘 것 + 지난 것 모두)
app.get('/api/products', requireAdmin, (req, res) => {
  res.json(readData());
});

// 오늘 상품만 (방문자 페이지용 - 누구나 조회 가능)
app.get('/api/products/today', (req, res) => {
  const today = dealDateStr(readOg().resetTime);
  const products = readData().filter(p => p.addedDate === today);
  res.json(products);
});

// 상품 1개 추가 (관리자 전용)
app.post('/api/products', requireAdmin, (req, res) => {
  const products = readData();
  const p = {
    id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
    name: (req.body.name || '').trim(),
    img: (req.body.img || '').trim(),
    link: (req.body.link || '').trim(),
    price: (req.body.price || '').trim(),
    discount: (req.body.discount || '').trim(),
    priceTag: (req.body.priceTag || '').trim(),
    unitPrice: (req.body.unitPrice || '').trim(),
    category: (req.body.category || '').trim(),
    isFlash: !!req.body.isFlash,
    flashEndTime: (req.body.flashEndTime || '').trim(),
    soldOut: !!req.body.soldOut,
    addedDate: dealDateStr(readOg().resetTime)
  };
  if (!p.name || !p.img || !p.link) {
    return res.status(400).json({ error: '상품명, 사진 주소, 링크는 꼭 필요해요.' });
  }
  products.push(p);
  writeData(products);
  res.json(p);
});

// 엑셀에서 뽑은 여러 상품 한번에 추가 (관리자 전용)
app.post('/api/products/bulk', requireAdmin, (req, res) => {
  const products = readData();
  const today = dealDateStr(readOg().resetTime);
  const existingLinks = new Set(products.filter(p => p.addedDate === today).map(p => p.link));
  let added = 0;

  (req.body.rows || []).forEach(r => {
    const name = (r.name || '').trim();
    const img = (r.img || '').trim();
    const link = (r.link || '').trim();
    if (!name || !img || !link) return;
    if (existingLinks.has(link)) return;
    products.push({
      id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
      name, img, link,
      price: (r.price || '').trim(),
      discount: (r.discount || '').trim(),
      priceTag: (r.priceTag || '').trim(),
      unitPrice: (r.unitPrice || '').trim(),
      category: (r.category || '').trim(),
      soldOut: !!r.soldOut,
      addedDate: today
    });
    existingLinks.add(link);
    added++;
  });

  writeData(products);
  res.json({ added });
});

// 상품 품절 상태 전환 (관리자 전용)
app.post('/api/products/:id/toggle-soldout', requireAdmin, (req, res) => {
  const products = readData();
  const p = products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '상품을 찾을 수 없어요.' });
  p.soldOut = !p.soldOut;
  writeData(products);
  res.json(p);
});

// 상품 일부 정보 수정: 카테고리, 선착순딜 여부/마감시간 등 (관리자 전용)
app.post('/api/products/:id/update', requireAdmin, (req, res) => {
  const products = readData();
  const p = products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '상품을 찾을 수 없어요.' });
  if (typeof req.body.category === 'string') p.category = req.body.category.trim();
  if (typeof req.body.isFlash === 'boolean') p.isFlash = req.body.isFlash;
  if (typeof req.body.flashEndTime === 'string') p.flashEndTime = req.body.flashEndTime.trim();
  writeData(products);
  res.json(p);
});

// 상품 삭제 (관리자 전용)
app.delete('/api/products/:id', requireAdmin, (req, res) => {
  let products = readData();
  products = products.filter(p => p.id !== req.params.id);
  writeData(products);
  res.json({ ok: true });
});

// 오늘이 아닌(지난) 상품을 한번에 삭제 (관리자 전용)
app.delete('/api/products/expired/all', requireAdmin, (req, res) => {
  const today = dealDateStr(readOg().resetTime);
  const products = readData();
  const remaining = products.filter(p => p.addedDate === today);
  const removed = products.length - remaining.length;
  writeData(remaining);
  res.json({ removed });
});

// ---- 공유 미리보기(OG) API (관리자 전용) ----
app.get('/api/og', requireAdmin, (req, res) => {
  res.json(readOg());
});

app.post('/api/og', requireAdmin, (req, res) => {
  const og = readOg();
  if (typeof req.body.image === 'string') og.image = req.body.image.trim();
  if (typeof req.body.icon === 'string') og.icon = req.body.icon.trim();
  if (typeof req.body.title === 'string' && req.body.title.trim()) og.title = req.body.title.trim();
  if (typeof req.body.description === 'string' && req.body.description.trim()) og.description = req.body.description.trim();
  if (typeof req.body.badge === 'string' && req.body.badge.trim()) og.badge = req.body.badge.trim();
  if (typeof req.body.resetTime === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(req.body.resetTime.trim())) {
    og.resetTime = req.body.resetTime.trim();
  }
  writeOg(og);
  res.json(og);
});

// 방문자 페이지가 초기화 시간을 알 수 있도록 공개 API로도 제공
app.get('/api/config', (req, res) => {
  const og = readOg();
  res.json({ resetTime: og.resetTime || '00:00', dealDate: dealDateStr(og.resetTime) });
});

app.post('/api/og/upload', requireAdmin, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없어요.' });
  const og = readOg();
  const ext = path.extname(req.file.originalname) || '.jpg';
  const filename = req.file.filename || ('og-' + Date.now() + ext);
  if (cloudflareStorage.isCloudflare) await cloudflareStorage.putObject(`uploads/${filename}`, req.file.buffer, req.file.mimetype);
  og.image = '/uploads/' + filename;
  writeOg(og);
  res.json(og);
});

app.post('/api/icon/upload', requireAdmin, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없어요.' });
  const og = readOg();
  const ext = path.extname(req.file.originalname) || '.jpg';
  const filename = req.file.filename || ('og-' + Date.now() + ext);
  if (cloudflareStorage.isCloudflare) await cloudflareStorage.putObject(`uploads/${filename}`, req.file.buffer, req.file.mimetype);
  og.icon = '/uploads/' + filename;
  writeOg(og);
  res.json(og);
});

// ---- 바탕화면 바로가기(PWA) ----
app.get('/manifest.json', (req, res) => {
  const og = readOg();
  const host = req.protocol + '://' + req.get('host');
  const iconUrl = og.icon
    ? (og.icon.startsWith('http') ? og.icon : host + og.icon)
    : host + '/assets/default-icon-512.png';
  const iconUrl192 = og.icon
    ? (og.icon.startsWith('http') ? og.icon : host + og.icon)
    : host + '/assets/default-icon-192.png';

  res.type('application/manifest+json').json({
    name: og.title || '쇼핑 레이더 오늘의 특가 갤러리',
    short_name: (og.title || '특가 갤러리').slice(0, 12),
    start_url: '/',
    display: 'standalone',
    background_color: '#070B16',
    theme_color: '#0064FF',
    icons: [
      { src: iconUrl192, sizes: '192x192', type: 'image/png' },
      { src: iconUrl, sizes: '512x512', type: 'image/png' }
    ]
  });
});

app.get('/sw.js', (req, res) => {
  res.type('application/javascript').send(
    "self.addEventListener('install', () => self.skipWaiting());\n" +
    "self.addEventListener('activate', () => self.clients.claim());\n" +
    "self.addEventListener('fetch', () => {});\n"
  );
});

// ---- 페이지 ----

app.get('/admin', requireAdmin, (req, res) => {
  if (cloudflareStorage.isCloudflare) return res.type('html').send(ADMIN_HTML);
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

app.get('/', (req, res) => {
  const og = readOg();
  const host = req.protocol + '://' + req.get('host');
  const imageUrl = og.image
    ? (og.image.startsWith('http') ? og.image : host + og.image)
    : '';
  const appleIconUrl = og.icon
    ? (og.icon.startsWith('http') ? og.icon : host + og.icon)
    : host + '/assets/default-icon-192.png';

  const render = (html) => {
    const metaTags = `
  <meta property="og:title" content="${escapeAttrStr(og.title)}">
  <meta property="og:description" content="${escapeAttrStr(og.description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeAttrStr(host)}">
  ${imageUrl ? `<meta property="og:image" content="${escapeAttrStr(imageUrl)}">` : ''}
  <meta name="twitter:card" content="${imageUrl ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${escapeAttrStr(og.title)}">
  <meta name="twitter:description" content="${escapeAttrStr(og.description)}">
  ${imageUrl ? `<meta name="twitter:image" content="${escapeAttrStr(imageUrl)}">` : ''}
`;
    res.send(
      html
        .replace('<!--OG_META-->', metaTags)
        .replace(/\{\{OG_TITLE\}\}/g, escapeHtmlStr(og.title))
        .replace(/\{\{OG_DESC\}\}/g, escapeHtmlStr(og.description))
        .replace(/\{\{OG_BADGE\}\}/g, escapeHtmlStr(og.badge))
        .replace(/\{\{APPLE_ICON\}\}/g, escapeAttrStr(appleIconUrl))
    );
  };

  if (cloudflareStorage.isCloudflare) return render(FRONT_HTML);
  fs.readFile(path.join(__dirname, 'views', 'front.html'), 'utf-8', (err, html) => {
    if (err) return res.status(500).send('페이지를 불러오지 못했어요.');
    render(html);
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('서버 실행 중: 포트 ' + PORT));
