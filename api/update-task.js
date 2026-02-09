// Vercel Serverless Function - 更新飞书任务
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
    
    // 构建更新数据
    const updateFields = {};
    
    // 状态
    if (fields.status) {
      updateFields['状态'] = fields.status;
    }
    
    // 开始日期（时间戳，毫秒）
    if (fields.startDate) {
      updateFields['开始日期'] = new Date(fields.startDate).getTime();
    }
    
    // 截止日期（时间戳，毫秒）
    if (fields.dueDate) {
      updateFields['截止日期'] = new Date(fields.dueDate).getTime();
    }
    
    // 完成日期（时间戳，毫秒）
    if (fields.completeDate) {
      updateFields['完成日期'] = new Date(fields.completeDate).getTime();
    }
    
    // 输出文件
    if (fields.outputFile) {
      updateFields['输出文件'] = fields.outputFile;
    }
    
    // 任务描述
    if (fields.description) {
      updateFields['任务描述'] = fields.description;
    }
    
    // 输出链接（Url 类型：需要 { link, text } 格式）
    if (fields.outputUrl) {
      updateFields['输出链接'] = { link: fields.outputUrl, text: fields.outputUrl };
    }
    
    // 输出文字
    if (fields.outputText) {
      updateFields['输出文字'] = fields.outputText;
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
        error: '更新任务失败: ' + (updateData.msg || JSON.stringify(updateData))
      });
    }
    
    return res.status(200).json({
      success: true,
      data: updateData.data,
      message: '任务更新成功'
    });
    
  } catch (error) {
    console.error('Update task error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
