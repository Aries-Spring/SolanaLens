'use strict';

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const CACHE_TTL = 60_000;
const PRICE_TTL = 30_000;
const RPC_TIMEOUT = 10_000;
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// In-memory caches — acceptable to lose on service worker restart (TTLs are short)
const walletCache = new Map();
let solPriceCache = { price: null, expiresAt: 0 };

async function getRpcUrl() {
  return new Promise(resolve => {
    chrome.storage.sync.get(['rpcUrl'], ({ rpcUrl }) => {
      resolve(rpcUrl || DEFAULT_RPC);
    });
  });
}

async function fetchWithTimeout(url, init, ms = RPC_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function rpcCall(rpcUrl, method, params) {
  const res = await fetchWithTimeout(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'RPC error');
  return json.result;
}

async function getSolPrice() {
  const now = Date.now();
  if (solPriceCache.price !== null && now < solPriceCache.expiresAt) {
    return solPriceCache.price;
  }
  try {
    const res = await fetchWithTimeout(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      {},
      8_000,
    );
    const data = await res.json();
    solPriceCache = { price: data?.solana?.usd ?? null, expiresAt: now + PRICE_TTL };
    return solPriceCache.price;
  } catch {
    return solPriceCache.price; // return stale if available
  }
}

async function fetchWalletData(address) {
  const now = Date.now();
  const cached = walletCache.get(address);
  if (cached && now < cached.expiresAt) return cached.data;

  const rpcUrl = await getRpcUrl();

  const [balance, spl, spl2022, signatures, solPrice] = await Promise.all([
    rpcCall(rpcUrl, 'getBalance', [address]),
    rpcCall(rpcUrl, 'getTokenAccountsByOwner', [
      address,
      { programId: SPL_TOKEN_PROGRAM },
      { encoding: 'base64' },
    ]).catch(() => ({ value: [] })),
    rpcCall(rpcUrl, 'getTokenAccountsByOwner', [
      address,
      { programId: TOKEN_2022_PROGRAM },
      { encoding: 'base64' },
    ]).catch(() => ({ value: [] })),
    rpcCall(rpcUrl, 'getSignaturesForAddress', [address, { limit: 1 }]).catch(() => []),
    getSolPrice(),
  ]);

  const data = {
    solBalance: (balance?.value ?? 0) / 1e9,
    tokenCount: (spl?.value?.length ?? 0) + (spl2022?.value?.length ?? 0),
    lastTxTime: signatures?.[0]?.blockTime ?? null,
    solPrice,
  };

  walletCache.set(address, { data, expiresAt: now + CACHE_TTL });
  return data;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FETCH_WALLET') {
    fetchWalletData(msg.address)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async response
  }
});
