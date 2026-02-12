// api/file.js - 极速版
// 优化：tenant_access_token 缓存（省 500ms），body size 限制 20MB

// token 缓存（Vercel warm instance 复用）
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 300000) {
    return cachedToken;
  }
  const APP_ID = process.env.LARK_APP_ID;
  const APP_SECRET = process.env.LARK_APP_SECRET;
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error('获取飞书凭证失败: ' + data.msg);
  cachedToken = data.tenant_access_token;
  tokenExpiry = now + (data.expire || 7200) * 1000;
  return cachedToken;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.LARK_APP_ID || !process.env.LARK_APP_SECRET) {
    return res.status(500).json({ success: false, error: '服务器配置错误：缺少飞书应用凭证' });
  }

  // ===== GET: 下载文件 =====
  if (req.method === 'GET') {
    try {
      const accessToken = await getAccessToken();
      const { file_token, file_name } = req.query;
      if (!file_token) return res.status(400).json({ success: false, error: '缺少 file_token' });
      
      const downloadRes = await fetch(
        `https://open.feishu.cn/open-apis/drive/v1/medias/${file_token}/download`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      if (!downloadRes.ok) return res.status(500).json({ success: false, error: '文件下载失败' });
      
      const fileBuffer = await downloadRes.arrayBuffer();
      res.setHeader('Content-Type', downloadRes.headers.get('content-type') || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file_name || 'file')}"`);
      return res.status(200).send(Buffer.from(fileBuffer));
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  // ===== POST: 上传文件 =====
  if (req.method === 'POST') {
    try {
      const { app_token, table_id, record_id, file_name, file_data, file_size } = req.body;
      if (!app_token || !table_id || !record_id || !file_name || !file_data) {
        return res.status(400).json({ success: false, error: '缺少必要参数' });
      }
      if (file_size && file_size > 20 * 1024 * 1024) {
        return res.status(400).json({ success: false, error: '文件不能超过 20MB' });
      }

      // token(缓存命中~0ms) 和 base64 解码并行
      const [accessToken, fileBuffer] = await Promise.all([
        getAccessToken(),
        Promise.resolve(Buffer.from(file_data, 'base64'))
      ]);

      // 上传到飞书
      const boundary = '----WKB' + Math.random().toString(36).slice(2, 10);
      const parts = `--${boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n${file_name}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="parent_type"\r\n\r\nbitable_file\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="parent_node"\r\n\r\n${app_token}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${fileBuffer.length}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file_name}"\r\nContent-Type: application/octet-stream\r\n\r\n`;

      const fullBody = Buffer.concat([Buffer.from(parts), fileBuffer, Buffer.from(`\r\n--${boundary}--\r\n`)]);

      const uploadRes = await fetch('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body: fullBody
      });
      const uploadData = await uploadRes.json();
      if (uploadData.code !== 0) {
        return res.status(500).json({ success: false, error: '文件上传失败: ' + (uploadData.msg || '') });
      }
      const fileToken = uploadData.data.file_token;

      // 更新记录附件
      const updateRes = await fetch(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${app_token}/tables/${table_id}/records/${record_id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
          body: JSON.stringify({ fields: { '输出文件': [{ file_token: fileToken }] } })
        }
      );
      const updateData = await updateRes.json();
      if (updateData.code !== 0) {
        return res.status(500).json({ success: false, error: '更新记录失败: ' + (updateData.msg || ''), file_token: fileToken });
      }

      return res.status(200).json({ success: true, data: { file_token: fileToken, file_name }, file_token: fileToken });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
}
