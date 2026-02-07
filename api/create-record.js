// /api/create-record.js - 通用记录创建接口
const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;

async function getTenantToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: LARK_APP_ID,
      app_secret: LARK_APP_SECRET
    })
  });
  const data = await res.json();
  return data.tenant_access_token;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { app_token, table_id, fields } = req.body;
    
    if (!app_token || !table_id || !fields) {
      return res.status(400).json({ success: false, error: 'Missing required fields: app_token, table_id, fields' });
    }

    const token = await getTenantToken();
    
    const response = await fetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${app_token}/tables/${table_id}/records`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fields })
      }
    );
    
    const result = await response.json();
    
    if (result.code === 0) {
      return res.status(200).json({ 
        success: true, 
        record_id: result.data?.record?.record_id,
        data: result.data 
      });
    } else {
      return res.status(400).json({ 
        success: false, 
        error: result.msg || 'Lark API error',
        code: result.code 
      });
    }
  } catch (error) {
    console.error('Create record error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
