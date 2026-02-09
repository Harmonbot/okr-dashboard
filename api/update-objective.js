// Vercel Serverless Function - 更新飞书目标
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  
  try {
    const { app_token, table_id, record_id, objective } = req.body;
    
    if (!app_token || !table_id || !record_id || !objective) {
      return res.status(400).json({ success: false, error: '缺少必要参数' });
    }
    
    const APP_ID = process.env.LARK_APP_ID;
    const APP_SECRET = process.env.LARK_APP_SECRET;
    
    if (!APP_ID || !APP_SECRET) {
      return res.status(500).json({ success: false, error: '服务器配置错误' });
    }
    
    // 获取 token
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
    });
    const tokenData = await tokenRes.json();
    if (tokenData.code !== 0) {
      return res.status(500).json({ success: false, error: '获取飞书凭证失败' });
    }
    
    // 构建字段
    const fields = {};
    if (objective.name) fields['目标名称'] = objective.name;
    if (objective.cycle) fields['目标周期'] = objective.cycle;
    if (objective.level) fields['目标层级'] = objective.level;
    if (objective.department !== undefined) fields['所属部门'] = objective.department || '';
    if (objective.status) fields['状态'] = objective.status;
    if (objective.progress !== undefined) fields['进度'] = objective.progress;
    
    // 更新记录
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
    if (updateData.code !== 0) {
      return res.status(500).json({ success: false, error: updateData.msg });
    }
    
    return res.status(200).json({ success: true, data: updateData.data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
