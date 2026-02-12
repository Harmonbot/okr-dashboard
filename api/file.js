// api/file.js - 合并 download + upload
// GET: 下载文件 ?file_token=xxx&file_name=xxx
// POST: 上传文件 - 支持两种方式:
//   1. multipart/form-data (推荐，更快，无Base64膨胀)
//   2. JSON body with base64 file_data (兼容旧版)

export const config = {
  api: {
    bodyParser: false, // 关闭默认解析，手动处理 JSON 和 multipart
    responseLimit: '20mb',
  },
  maxDuration: 30,
};

// 手动解析 JSON body
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        resolve(body);
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// 解析 multipart/form-data（轻量实现，不依赖第三方库）
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
    if (!boundaryMatch) return reject(new Error('No boundary found'));
    const boundary = boundaryMatch[1] || boundaryMatch[2];

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const parts = {};
        let fileData = null;
        let fileName = '';
        let fileMimeType = 'application/octet-stream';

        // 分割各 part
        const boundaryBuf = Buffer.from('--' + boundary);
        const endBuf = Buffer.from('--' + boundary + '--');
        
        let pos = 0;
        const positions = [];
        while (pos < buffer.length) {
          const idx = buffer.indexOf(boundaryBuf, pos);
          if (idx === -1) break;
          positions.push(idx);
          pos = idx + boundaryBuf.length;
        }

        for (let i = 0; i < positions.length - 1; i++) {
          const start = positions[i] + boundaryBuf.length;
          let end = positions[i + 1];
          
          // 去掉前后的 \r\n
          let partStart = start;
          if (buffer[partStart] === 0x0d && buffer[partStart + 1] === 0x0a) partStart += 2;
          let partEnd = end;
          if (buffer[partEnd - 2] === 0x0d && buffer[partEnd - 1] === 0x0a) partEnd -= 2;
          
          const partBuf = buffer.slice(partStart, partEnd);
          
          // 找到 header 和 body 的分界（\r\n\r\n）
          const headerEnd = partBuf.indexOf('\r\n\r\n');
          if (headerEnd === -1) continue;
          
          const headerStr = partBuf.slice(0, headerEnd).toString('utf8');
          const bodyBuf = partBuf.slice(headerEnd + 4);
          
          const nameMatch = headerStr.match(/name="([^"]+)"/);
          const filenameMatch = headerStr.match(/filename="([^"]+)"/);
          const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);
          
          if (filenameMatch) {
            // 这是文件字段
            fileData = bodyBuf;
            fileName = filenameMatch[1];
            if (ctMatch) fileMimeType = ctMatch[1].trim();
          } else if (nameMatch) {
            // 普通字段
            parts[nameMatch[1]] = bodyBuf.toString('utf8');
          }
        }

        resolve({ fields: parts, fileData, fileName, fileMimeType });
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

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
      const contentType = req.headers['content-type'] || '';
      let fileBuffer, file_name, app_token, table_id, record_id;

      if (contentType.includes('multipart/form-data')) {
        // ===== 方式1: multipart/form-data（更快，推荐）=====
        const { fields, fileData, fileName } = await parseMultipart(req);
        if (!fileData || fileData.length === 0) {
          return res.status(400).json({ success: false, error: '未找到上传文件' });
        }
        fileBuffer = fileData;
        file_name = fields.file_name || fileName || 'file';
        app_token = fields.app_token;
        table_id = fields.table_id;
        record_id = fields.record_id;
      } else {
        // ===== 方式2: JSON body + base64（兼容旧版）=====
        const body = await parseJsonBody(req);
        const { file_data, file_size } = body;
        app_token = body.app_token;
        table_id = body.table_id;
        record_id = body.record_id;
        file_name = body.file_name;

        if (!file_data) {
          return res.status(400).json({ success: false, error: '缺少 file_data 参数' });
        }
        if (file_size && file_size > 20 * 1024 * 1024) {
          return res.status(400).json({ success: false, error: '文件大小不能超过 20MB' });
        }
        fileBuffer = Buffer.from(file_data, 'base64');
      }

      if (!app_token || !table_id || !record_id || !file_name) {
        return res.status(400).json({ success: false, error: '缺少必要参数 (app_token, table_id, record_id, file_name)' });
      }

      // 1. 上传文件到飞书云空间
      const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);

      let bodyParts = '';
      bodyParts += `--${boundary}\r\n`;
      bodyParts += `Content-Disposition: form-data; name="file_name"\r\n\r\n`;
      bodyParts += `${file_name}\r\n`;
      bodyParts += `--${boundary}\r\n`;
      bodyParts += `Content-Disposition: form-data; name="parent_type"\r\n\r\n`;
      bodyParts += `bitable_file\r\n`;
      bodyParts += `--${boundary}\r\n`;
      bodyParts += `Content-Disposition: form-data; name="parent_node"\r\n\r\n`;
      bodyParts += `${app_token}\r\n`;
      bodyParts += `--${boundary}\r\n`;
      bodyParts += `Content-Disposition: form-data; name="size"\r\n\r\n`;
      bodyParts += `${fileBuffer.length}\r\n`;
      bodyParts += `--${boundary}\r\n`;
      bodyParts += `Content-Disposition: form-data; name="file"; filename="${file_name}"\r\n`;
      bodyParts += `Content-Type: application/octet-stream\r\n\r\n`;

      const bodyStart = Buffer.from(bodyParts, 'utf8');
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

      // 2. 更新记录附件字段
      const updateRes = await fetch(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${app_token}/tables/${table_id}/records/${record_id}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
          },
          body: JSON.stringify({
            fields: { '输出文件': [{ file_token: fileToken }] }
          })
        }
      );
      const updateData = await updateRes.json();

      if (updateData.code !== 0) {
        console.error('Update record error:', updateData);
        return res.status(500).json({
          success: false,
          error: '更新记录失败: ' + (updateData.msg || JSON.stringify(updateData)),
          file_token: fileToken
        });
      }

      return res.status(200).json({
        success: true,
        data: { file_token: fileToken, file_name },
        file_token: fileToken,
        message: '文件上传成功'
      });

    } catch (error) {
      console.error('Upload file error:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
}
