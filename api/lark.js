// api/lark.js - 优化版：并行获取 + 自动分页 + Token缓存 + 新闻聚合

// Token 缓存（Vercel 同实例复用）
let tokenCache = { token: null, expiresAt: 0 };

// 新闻缓存（2小时）
let newsCache = { data: null, ts: 0 };
const NEWS_CACHE_TTL = 2 * 60 * 60 * 1000;

async function getTenantToken(appId, appSecret) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error('获取 token 失败: ' + data.msg);
  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire - 60) * 1000
  };
  return data.tenant_access_token;
}

// 获取单张表全部记录（自动分页）
async function getAllRecords(token, appToken, tableId) {
  const allRecords = [];
  let pageToken = null;
  let hasMore = true;

  while (hasMore) {
    let url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=500`;
    if (pageToken) url += '&page_token=' + pageToken;

    const res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();

    if (data.code !== 0) {
      console.error(`Table ${tableId} error:`, data.msg);
      break;
    }

    if (data.data?.items) {
      allRecords.push(...data.data.items);
    }
    hasMore = data.data?.has_more || false;
    pageToken = data.data?.page_token || null;
  }

  return allRecords;
}

// ===== 新闻聚合功能 =====
async function fetchNews() {
  // 返回缓存
  if (newsCache.data && Date.now() - newsCache.ts < NEWS_CACHE_TTL) {
    return { data: newsCache.data, cached: true };
  }

  const allNews = [];
  const queries = [
    { q: '跨境电商', label: '跨境电商' },
    { q: '亚马逊+卖家', label: '亚马逊' },
    { q: 'TikTok+Shop+OR+Temu+OR+SHEIN+电商', label: 'TikTok/Temu/SHEIN' },
  ];

  for (const { q } of queries) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
      const gRes = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const xml = await gRes.text();
      const items = [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<source[^>]*>([\s\S]*?)<\/source>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>[\s\S]*?<\/item>/g)];
      items.slice(0, 6).forEach(m => {
        const title = m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        const source = m[2].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        const pubDate = m[3]?.trim() || '';
        if (title && title.length > 5) {
          allNews.push({ title, summary: '', source, time: pubDate });
        }
      });
    } catch (e) {
      console.log(`News query "${q}" failed:`, e.message);
    }
  }

  // 去重
  const seen = new Set();
  const unique = allNews.filter(n => {
    const key = n.title.substring(0, 25);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);

  // 格式化相对时间
  const now = new Date();
  unique.forEach(n => {
    if (n.time) {
      try {
        const d = new Date(n.time);
        const diffH = Math.floor((now - d) / (1000 * 60 * 60));
        n.timeAgo = diffH < 1 ? '刚刚' : diffH < 24 ? `${diffH}小时前` : `${Math.floor(diffH / 24)}天前`;
      } catch (e) { n.timeAgo = ''; }
    }
  });

  if (unique.length > 0) {
    newsCache = { data: unique, ts: Date.now() };
  }

  return { data: unique, cached: false };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ===== 新闻路由：?action=news =====
  if (req.query.action === 'news') {
    try {
      const result = await fetchNews();
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
      return res.status(200).json({ success: true, ...result, count: result.data.length });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message, data: [] });
    }
  }

  // ===== 原有飞书数据路由 =====
  const { LARK_APP_ID, LARK_APP_SECRET } = process.env;
  if (!LARK_APP_ID || !LARK_APP_SECRET) {
    return res.status(500).json({ error: '缺少飞书应用配置' });
  }

  try {
    const token = await getTenantToken(LARK_APP_ID, LARK_APP_SECRET);
    const appToken = req.query.app_token || 'N5OqbwkO1a2PbpsaM05ckGrMnxg';

    // 获取表列表
    const tablesRes = await fetch('https://open.feishu.cn/open-apis/bitable/v1/apps/' + appToken + '/tables?page_size=100', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const tablesData = await tablesRes.json();
    if (tablesData.code !== 0) {
      return res.status(500).json({ error: '获取表列表失败', detail: tablesData });
    }

    const tables = tablesData.data.items || [];

    // ⚡ 并行获取所有表数据（核心优化：从 for 串行 → Promise.all 并行）
    const results = await Promise.all(
      tables.map(table =>
        getAllRecords(token, appToken, table.table_id)
          .then(records => ({ name: table.name, table_id: table.table_id, records }))
          .catch(err => {
            console.error(`Failed: ${table.name}`, err.message);
            return { name: table.name, table_id: table.table_id, records: [] };
          })
      )
    );

    // 组装结果（保持原格式完全兼容）
    const result = {};
    results.forEach(r => {
      result[r.name] = {
        table_id: r.table_id,
        records: r.records
      };
    });

    // CDN 缓存 30秒 + 过期后可用旧数据60秒
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

    return res.status(200).json({
      success: true,
      data: result,
      tables: tables.map(function(t) { return { name: t.name, table_id: t.table_id }; })
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
