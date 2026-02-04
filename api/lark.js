// Vercel Serverless Function - 飞书 API 代理
// 部署后需要在 Vercel 环境变量中配置 LARK_APP_ID 和 LARK_APP_SECRET

export default async function handler(req, res) {
  // 设置 CORS
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
    // 1. 获取 tenant_access_token
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: LARK_APP_ID,
        app_secret: LARK_APP_SECRET
      })
    });
    const tokenData = await tokenRes.json();
    
    if (tokenData.code !== 0) {
      return res.status(500).json({ error: '获取 token 失败', detail: tokenData });
    }

    const token = tokenData.tenant_access_token;

    // 2. 获取多维表格数据
    const appToken = req.query.app_token || 'N5OqbwkO1a2PbpsaM05ckGrMnxg';
    
    // 获取所有表
    const tablesRes = await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables?page_size=100`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const tablesData = await tablesRes.json();

    if (tablesData.code !== 0) {
      return res.status(500).json({ error: '获取表列表失败', detail: tablesData });
    }

    // 3. 获取每个表的记录
    const tables = tablesData.data.items || [];
    const result = {};

    for (const table of tables) {
      const recordsRes = await fetch(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${table.table_id}/records?page_size=500`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const recordsData = await recordsRes.json();

      result[table.name] = {
        table_id: table.table_id,
        records: recordsData.data?.items || []
      };
    }

    return res.status(200).json({
      success: true,
      data: result,
      tables: tables.map(t => ({ name: t.name, table_id: t.table_id }))
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
