const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');

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

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'front.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('서버 실행 중: 포트 ' + PORT));
