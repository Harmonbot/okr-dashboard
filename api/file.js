// api/file.js - 合并 download-file.js + upload-file.js
// GET: 下载文件 ?file_token=xxx&file_name=xxx
// POST: 上传文件 (JSON body with base64 file_data)
export default async function handler(req, res) {
  // 设置 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 获取飞书 access_token
  const APP_ID = process.env.LARK_APP_ID;
  const APP_SECRET = process.env.LARK_APP_SECRET;
  
  if (!APP_ID || !APP_SECRET) {
    return res.status(500).json({ success: false, error: '服务器配置错误：缺少飞书应用凭证' });
  }

  const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });
  const tokenData = await tokenRes.json();
  if (tokenData.code !== 0) {
    return res.status(500).json({ success: false, error: '获取飞书凭证失败: ' + tokenData.msg });
  }
  const accessToken = tokenData.tenant_access_token;

  // ===== GET: 下载文件 =====
  if (req.method === 'GET') {
    try {
      const { file_token, file_name } = req.query;
      if (!file_token) {
        return res.status(400).json({ success: false, error: '缺少 file_token 参数' });
      }

      const downloadRes = await fetch(
        `https://open.feishu.cn/open-apis/drive/v1/medias/${file_token}/download`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );

      if (!downloadRes.ok) {
        return res.status(500).json({ success: false, error: '文件下载失败' });
      }

      const fileBuffer = await downloadRes.arrayBuffer();
      const contentType = downloadRes.headers.get('content-type') || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file_name || 'file')}"`);
      return res.status(200).send(Buffer.from(fileBuffer));

    } catch (error) {
      console.error('Download file error:', error);
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
        return res.status(400).json({ success: false, error: '文件大小不能超过 20MB' });
      }

      // 将 Base64 转换为 Buffer
      const fileBuffer = Buffer.from(file_data, 'base64');

      // 1. 上传文件到飞书，获取 file_token
      const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);

      let body = '';
      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="file_name"\r\n\r\n`;
      body += `${file_name}\r\n`;

      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="parent_type"\r\n\r\n`;
      body += `bitable_file\r\n`;

      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="parent_node"\r\n\r\n`;
      body += `${app_token}\r\n`;

      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="size"\r\n\r\n`;
      body += `${fileBuffer.length}\r\n`;

      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="file"; filename="${file_name}"\r\n`;
      body += `Content-Type: application/octet-stream\r\n\r\n`;

      const bodyStart = Buffer.from(body, 'utf8');
      const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
      const fullBody = Buffer.concat([bodyStart, fileBuffer, bodyEnd]);

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
        console.error('Upload error:', uploadData);
        return res.status(500).json({
          success: false,
          error: '文件上传失败: ' + (uploadData.msg || JSON.stringify(uploadData))
        });
      }

      const fileToken = uploadData.data.file_token;

      // 2. 更新记录，添加附件到「输出文件」字段
      const updateRes = await fetch(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${app_token}/tables/${table_id}/records/${record_id}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
          },
          body: JSON.stringify({
            fields: {
              '输出文件': [{ file_token: fileToken }]
            }
          })
        }
      );

      const updateData = await updateRes.json();

      if (updateData.code !== 0) {
        console.error('Update record error:', updateData);
        return res.status(500).json({
          success: false,
          error: '更新记录失败: ' + (updateData.msg || JSON.stringify(updateData))
        });
      }

      return res.status(200).json({
        success: true,
        data: { file_token: fileToken, file_name: file_name },
        message: '文件上传成功'
      });

    } catch (error) {
      console.error('Upload file error:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
}
