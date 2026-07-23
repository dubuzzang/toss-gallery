const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.json());

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, 'og-' + Date.now() + ext);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 } // 8MB
});

app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');
const OG_FILE = path.join(__dirname, 'og.json');

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) {
    return [];
  }
}

function writeData(products) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(products, null, 2));
}

const DEFAULT_OG = {
  title: '쇼핑 레이더 오늘의 특가 갤러리',
  description: '토스쇼핑 활동으로 수수료를 받습니다',
  badge: '토스 오늘의 특가 모음',
  image: ''
};

function readOg() {
  try {
    return { ...DEFAULT_OG, ...JSON.parse(fs.readFileSync(OG_FILE, 'utf-8')) };
  } catch (e) {
    return { ...DEFAULT_OG };
  }
}

function writeOg(og) {
  fs.writeFileSync(OG_FILE, JSON.stringify(og, null, 2));
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

// 전체 상품 목록 (관리자 페이지용 - 오늘 것 + 지난 것 모두)
app.get('/api/products', (req, res) => {
  res.json(readData());
});

// 오늘 상품만 (방문자 페이지용)
app.get('/api/products/today', (req, res) => {
  const today = todayStr();
  const products = readData().filter(p => p.addedDate === today);
  res.json(products);
});

// 상품 1개 추가
app.post('/api/products', (req, res) => {
  const products = readData();
  const p = {
    id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
    name: (req.body.name || '').trim(),
    img: (req.body.img || '').trim(),
    link: (req.body.link || '').trim(),
    price: (req.body.price || '').trim(),
    discount: (req.body.discount || '').trim(),
    addedDate: todayStr()
  };
  if (!p.name || !p.img || !p.link) {
    return res.status(400).json({ error: '상품명, 사진 주소, 링크는 꼭 필요해요.' });
  }
  products.push(p);
  writeData(products);
  res.json(p);
});

// 엑셀에서 뽑은 여러 상품 한번에 추가
app.post('/api/products/bulk', (req, res) => {
  const products = readData();
  const today = todayStr();
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
      addedDate: today
    });
    existingLinks.add(link);
    added++;
  });

  writeData(products);
  res.json({ added });
});

// 상품 삭제
app.delete('/api/products/:id', (req, res) => {
  let products = readData();
  products = products.filter(p => p.id !== req.params.id);
  writeData(products);
  res.json({ ok: true });
});

// 공유 미리보기(OG) 설정 조회
app.get('/api/og', (req, res) => {
  res.json(readOg());
});

// 공유 미리보기 이미지 주소로 저장
app.post('/api/og', (req, res) => {
  const og = readOg();
  if (typeof req.body.image === 'string') og.image = req.body.image.trim();
  if (typeof req.body.title === 'string' && req.body.title.trim()) og.title = req.body.title.trim();
  if (typeof req.body.description === 'string' && req.body.description.trim()) og.description = req.body.description.trim();
  if (typeof req.body.badge === 'string' && req.body.badge.trim()) og.badge = req.body.badge.trim();
  writeOg(og);
  res.json(og);
});

// 공유 미리보기 이미지 파일 업로드
app.post('/api/og/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없어요.' });
  const og = readOg();
  og.image = '/uploads/' + req.file.filename;
  writeOg(og);
  res.json(og);
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/', (req, res) => {
  const og = readOg();
  const host = req.protocol + '://' + req.get('host');
  const imageUrl = og.image
    ? (og.image.startsWith('http') ? og.image : host + og.image)
    : '';

  fs.readFile(path.join(__dirname, 'public', 'front.html'), 'utf-8', (err, html) => {
    if (err) return res.status(500).send('페이지를 불러오지 못했어요.');
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
        .replace('{{OG_TITLE}}', escapeHtmlStr(og.title))
        .replace('{{OG_DESC}}', escapeHtmlStr(og.description))
        .replace('{{OG_BADGE}}', escapeHtmlStr(og.badge))
    );
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('서버 실행 중: 포트 ' + PORT));
