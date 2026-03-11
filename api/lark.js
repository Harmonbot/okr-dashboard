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
      // 提取每个 <item> 块
      const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
      itemBlocks.slice(0, 6).forEach(block => {
        const content = block[1];
        const titleMatch = content.match(/<title>([\s\S]*?)<\/title>/);
        const sourceMatch = content.match(/<source[^>]*>([\s\S]*?)<\/source>/);
        const pubDateMatch = content.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
        // Google News RSS link 格式可能是: <link/>URL 或 <link>URL</link>
        let link = '';
        const linkMatch1 = content.match(/<link>([\s\S]*?)<\/link>/);
        const linkMatch2 = content.match(/<link\s*\/>\s*(https?:\/\/[^\s<]+)/);
        const linkMatch3 = content.match(/<link>(https?:\/\/[^\s<]+)/);
        if (linkMatch1) link = linkMatch1[1].trim();
        else if (linkMatch2) link = linkMatch2[1].trim();
        else if (linkMatch3) link = linkMatch3[1].trim();
        
        const title = (titleMatch?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        const source = (sourceMatch?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        const pubDate = (pubDateMatch?.[1] || '').trim();
        link = link.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        if (title && title.length > 5) {
          allNews.push({ title, summary: '', source, time: pubDate, link });
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

    // ⚡ 并行获取所有表数据 + 项目表字段选项
    const PROJECT_TABLE_ID = 'tblYM02NyVj3rUkR';
    const [recordResults, fieldsRes] = await Promise.all([
      Promise.all(
        tables.map(table =>
          getAllRecords(token, appToken, table.table_id)
            .then(records => ({ name: table.name, table_id: table.table_id, records }))
            .catch(err => {
              console.error(`Failed: ${table.name}`, err.message);
              return { name: table.name, table_id: table.table_id, records: [] };
            })
        )
      ),
      fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${PROJECT_TABLE_ID}/fields?page_size=50`, {
        headers: { 'Authorization': 'Bearer ' + token }
      }).then(r => r.json()).catch(() => null)
    ]);

    // 组装结果（保持原格式完全兼容）
    const result = {};
    recordResults.forEach(r => {
      result[r.name] = {
        table_id: r.table_id,
        records: r.records
      };
    });

    // 提取字段选项
    const fieldOptions = {};
    if (fieldsRes?.code === 0 && fieldsRes?.data?.items) {
      fieldsRes.data.items.forEach(f => {
        if (f.property?.options && f.property.options.length > 0) {
          fieldOptions[f.field_name] = f.property.options.map(o => o.name);
        }
      });
    }

    // CDN 缓存 30秒 + 过期后可用旧数据60秒
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

    return res.status(200).json({
      success: true,
      data: result,
      fieldOptions,
      tables: tables.map(function(t) { return { name: t.name, table_id: t.table_id }; })
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
