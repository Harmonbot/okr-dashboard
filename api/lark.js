// api/lark.js - 优化版：并行获取 + 自动分页 + Token缓存

// Token 缓存（Vercel 同实例复用）
let tokenCache = { token: null, expiresAt: 0 };

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

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
