// Vercel Serverless Function: 通用记录更新（直接传中文字段名）
// 部署到 /api/update-record.js

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const { app_token, table_id, record_id, fields } = req.body;
  if (!app_token || !table_id || !record_id || !fields) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  try {
    // 获取 tenant_access_token
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: process.env.LARK_APP_ID,
        app_secret: process.env.LARK_APP_SECRET
      })
    });
    const tokenData = await tokenRes.json();
    if (tokenData.code !== 0) throw new Error('Token error: ' + tokenData.msg);

    // 直接更新记录（fields 使用中文字段名，直接透传给飞书）
    const updateRes = await fetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${app_token}/tables/${table_id}/records/${record_id}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenData.tenant_access_token}`
        },
        body: JSON.stringify({ fields })
      }
    );
    const updateData = await updateRes.json();
    if (updateData.code !== 0) throw new Error(updateData.msg || 'Update failed');

    return res.status(200).json({ success: true, data: updateData.data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
