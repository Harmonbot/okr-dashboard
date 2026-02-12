// Vercel Serverless Function - 更新飞书任务（含通用字段透传）
export default async function handler(req, res) {
  // 设置 CORS
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
    const { app_token, table_id, record_id, fields } = req.body;
    
    if (!app_token || !table_id || !record_id || !fields) {
      return res.status(400).json({ success: false, error: '缺少必要参数' });
    }
    
    // 获取飞书 access_token
    const APP_ID = process.env.LARK_APP_ID;
    const APP_SECRET = process.env.LARK_APP_SECRET;
    
    if (!APP_ID || !APP_SECRET) {
      return res.status(500).json({ success: false, error: '服务器配置错误：缺少飞书应用凭证' });
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
      return res.status(500).json({ success: false, error: '获取飞书凭证失败: ' + tokenData.msg });
    }
    
    const accessToken = tokenData.tenant_access_token;
    
    // 构建更新数据 - 已知字段做映射，未知字段直接透传
    const updateFields = {};
    
    // 已知任务字段映射
    // 注意：飞书表中没有「输出链接」字段，链接和文字统一存入「输出文字」
    const knownFieldMap = {
      'status': '状态',
      'startDate': { name: '开始日期', transform: v => new Date(v).getTime() },
      'dueDate': { name: '截止日期', transform: v => new Date(v).getTime() },
      'completeDate': { name: '完成日期', transform: v => new Date(v).getTime() },
      'outputFile': '输出文件',
      'description': '任务描述',
      'outputText': '输出文字'
    };
    
    // 特殊处理：outputUrl 和 outputText 合并到「输出文字」字段
    // 格式：链接||文档标题\n补充文字
    if (fields.outputUrl) {
      const link = fields.outputUrl;
      const text = fields.outputText || '';
      
      // 尝试获取飞书文档标题
      let docTitle = '';
      if (link.includes('feishu.cn') || link.includes('larksuite.com')) {
        try {
          docTitle = await resolveFeishuDocTitle(link, accessToken);
        } catch (e) {
          console.log('Failed to resolve doc title:', e.message);
        }
      }
      
      // 存储格式：链接||标题\n补充文字
      // ||是分隔符，前端解析时用
      const linkPart = docTitle ? `${link}||${docTitle}` : link;
      updateFields['输出文字'] = text ? `${linkPart}\n${text}` : linkPart;
      
      delete fields.outputUrl;
      delete fields.outputText;
    }
    
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      const mapping = knownFieldMap[key];
      if (mapping) {
        if (typeof mapping === 'string') {
          updateFields[mapping] = value;
        } else {
          updateFields[mapping.name] = mapping.transform(value);
        }
      } else {
        // 未知字段直接透传（支持中文字段名如 '跳过节点'）
        updateFields[key] = value;
      }
    }
    
    // 调用飞书 API 更新记录
    const updateRes = await fetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${app_token}/tables/${table_id}/records/${record_id}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({ fields: updateFields })
      }
    );
    
    const updateData = await updateRes.json();
    
    if (updateData.code !== 0) {
      return res.status(500).json({ 
        success: false, 
        error: '更新记录失败: ' + (updateData.msg || JSON.stringify(updateData))
      });
    }
    
    return res.status(200).json({
      success: true,
      data: updateData.data,
      message: '记录更新成功'
    });
    
  } catch (error) {
    console.error('Update task error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

// 从飞书链接提取文档 token 和类型，调用 API 获取标题
async function resolveFeishuDocTitle(url, accessToken) {
  // 解析 URL 路径提取 token
  // 常见格式：
  // https://xxx.feishu.cn/docx/TOKEN
  // https://xxx.feishu.cn/sheets/TOKEN
  // https://xxx.feishu.cn/base/TOKEN?table=xxx
  // https://xxx.feishu.cn/wiki/TOKEN
  // https://xxx.feishu.cn/drive/folder/TOKEN
  // https://xxx.feishu.cn/file/TOKEN
  
  const u = new URL(url);
  const pathParts = u.pathname.split('/').filter(Boolean);
  
  if (pathParts.length < 2) return '';
  
  const docType = pathParts[0]; // docx, sheets, base, wiki, slides, mindnotes, file, drive
  const token = pathParts[1] === 'folder' ? pathParts[2] : pathParts[1];
  
  if (!token) return '';
  
  // 根据类型选择 API
  try {
    let title = '';
    
    if (docType === 'docx' || docType === 'doc') {
      // 文档 API
      const res = await fetch(`https://open.feishu.cn/open-apis/docx/v1/documents/${token}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const data = await res.json();
      title = data?.data?.document?.title || '';
    } 
    else if (docType === 'sheets' || docType === 'sheet') {
      // 电子表格 API
      const res = await fetch(`https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${token}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const data = await res.json();
      title = data?.data?.spreadsheet?.title || '';
    }
    else if (docType === 'base') {
      // 多维表格 API
      const res = await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${token}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const data = await res.json();
      title = data?.data?.app?.name || '';
    }
    else if (docType === 'wiki') {
      // 知识库节点 API
      const res = await fetch(`https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${token}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const data = await res.json();
      title = data?.data?.node?.title || '';
    }
    else if (docType === 'slides') {
      // 幻灯片 — 用通用元数据 API
      title = await getDocMetaTitle(token, accessToken);
    }
    else if (docType === 'mindnotes' || docType === 'mindnote') {
      title = await getDocMetaTitle(token, accessToken);
    }
    else if (docType === 'minutes') {
      title = await getDocMetaTitle(token, accessToken);
    }
    
    // 通用兜底：如果上面没获取到，用元数据 API 试一次
    if (!title && docType !== 'drive' && docType !== 'file' && docType !== 'folder') {
      title = await getDocMetaTitle(token, accessToken);
    }
    
    return title;
  } catch (e) {
    console.log('resolveFeishuDocTitle error:', e.message);
    return '';
  }
}

// 通用文档元数据 API 获取标题
async function getDocMetaTitle(token, accessToken) {
  try {
    const res = await fetch(`https://open.feishu.cn/open-apis/drive/v1/metas/batch_query`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}` 
      },
      body: JSON.stringify({
        request_docs: [{ doc_token: token, doc_type: 'unknown' }]
      })
    });
    const data = await res.json();
    return data?.data?.metas?.[0]?.title || '';
  } catch {
    return '';
  }
}
