const express = require('express');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());

// 클라우드타입 리버스 프록시 뒤의 실제 클라이언트 IP 인식 (필수)
app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const SECRET_KEY = process.env.WEBHOOK_SECRET;
const BASE_URL = process.env.BINANCE_BASE_URL || 'https://fapi.binance.com';

// 트레이딩뷰 공식 웹훅 IP 목록 (Caddy 없이 Express 자체 보안 검증)
const TRADINGVIEW_IPS = [
  '52.89.214.238',
  '34.212.75.30',
  '54.218.53.128',
  '52.32.178.7',
  '127.0.0.1'
];

function verifyTradingViewIp(req, res, next) {
  const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const clientIp = rawIp.split(',')[0].trim();

  // 운영 환경(production)에서 트레이딩뷰 IP가 아니면 자동 차단
  if (process.env.NODE_ENV === 'production' && !TRADINGVIEW_IPS.includes(clientIp)) {
    console.warn(`[보안 차단] 비인가 IP 웹훅 요청 차단: ${clientIp}`);
    return res.status(403).json({ error: 'Forbidden: Unauthorized IP' });
  }

  next();
}

function sign(query) {
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

async function sendOrder(symbol, side, positionSide, qty, closePosition = false) {
  if (!API_KEY || !API_SECRET) {
    console.log('[모의 체결 모드 - API키 없음]', { symbol, side, positionSide, qty, closePosition });
    return { mock: true, symbol, side, positionSide, qty, closePosition };
  }

  const cleanSymbol = symbol.replace('.P', '').trim();
  const timestamp = Date.now();
  const params = {
    symbol: cleanSymbol,
    side: side,
    positionSide: positionSide,
    type: 'MARKET',
    timestamp: timestamp
  };

  if (closePosition) {
    params.closePosition = 'true';
  } else if (qty) {
    params.quantity = qty;
  }

  const queryString = new URLSearchParams(params).toString();
  const signature = sign(queryString);
  const url = `${BASE_URL}/fapi/v1/order?${queryString}&signature=${signature}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-MBX-APIKEY': API_KEY,
      'Content-Type': 'application/json'
    }
  });
  const data = await res.json();
  console.log('[바이낸스 선물 체결 결과]', data);
  return data;
}

// 트레이딩뷰 웹훅 수신 라우트
app.post('/api/webhook', verifyTradingViewIp, async (req, res) => {
  try {
    const body = req.body;
    console.log('[웹훅 수신 데이터]', body);

    if (SECRET_KEY && body.secret && body.secret !== SECRET_KEY) {
      console.warn('[보안 차단] 웹훅 비밀번호 불일치');
      return res.status(403).json({ error: '비밀번호 불일치' });
    }

    const { action, side, positionSide, qty, symbol } = body;
    const coin = symbol || 'BTCUSDT';
    const quantity = qty || '0.002';

    switch (action) {
      case 'ENTRY':
      case 'LOCK_ENTRY':
      case 'ADD_POSITION':
      case 'CUT_ADD':
        await sendOrder(coin, side, positionSide, quantity);
        break;
      case 'CLOSE_POSITION':
        await sendOrder(coin, side, positionSide, null, true);
        break;
      case 'CLOSE_ALL_HEDGE':
        await sendOrder(coin, 'SELL', 'LONG', null, true);
        await sendOrder(coin, 'BUY', 'SHORT', null, true);
        break;
      default:
        console.log('알 수 없는 액션:', action);
    }

    res.json({ status: 'OK', action });
  } catch (e) {
    console.error('[웹훅 에러]', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ONLINE', bot: 'V5 Hedge Sniper Bot' }));
app.get('/', (req, res) => res.send('V5 Hedge Bot is Running on Cloudtype!'));

// 클라우드타입 필수: 0.0.0.0 바인딩
app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`[V5 Bot] 서버 시작 완료: http://0.0.0.0:${PORT}`);
});
