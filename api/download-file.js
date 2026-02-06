// Vercel Serverless Function - 代理下载飞书附件
export default async function handler(req, res) {
  // 设置 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  
  try {
    const { file_token, file_name } = req.query;
    
    if (!file_token) {
      return res.status(400).json({ success: false, error: '缺少 file_token 参数' });
    }
    
    // 获取飞书 access_token
    const APP_ID = process.env.LARK_APP_ID;
    const APP_SECRET = process.env.LARK_APP_SECRET;
    
    if (!APP_ID || !APP_SECRET) {
      return res.status(500).json({ success: false, error: '服务器配置错误' });
    }
    
    // 获取 tenant_access_token
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: APP_ID,
        app_secret: APP_SECRET
      })
    });
    
    const tokenData = await tokenRes.json();
    if (tokenData.code !== 0) {
      return res.status(500).json({ success: false, error: '获取飞书凭证失败' });
    }
    
    const accessToken = tokenData.tenant_access_token;
    
    // 下载文件
    const downloadRes = await fetch(
      `https://open.feishu.cn/open-apis/drive/v1/medias/${file_token}/download`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );
    
    if (!downloadRes.ok) {
      return res.status(500).json({ success: false, error: '文件下载失败' });
    }
    
    // 获取文件内容
    const fileBuffer = await downloadRes.arrayBuffer();
    
    // 设置响应头
    const contentType = downloadRes.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file_name || 'file')}"`);
    
    // 返回文件
    return res.status(200).send(Buffer.from(fileBuffer));
    
  } catch (error) {
    console.error('Download file error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
