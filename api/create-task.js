// Vercel Serverless Function - 创建飞书任务
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
    const { app_token, table_id, task } = req.body;
    
    if (!app_token || !table_id || !task) {
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
    
    // 构建任务数据
    const fields = {
      '任务名称': task.name
    };
    
    // 优先级
    if (task.priority) {
      fields['优先级'] = task.priority;
    }
    
    // 状态
    if (task.status) {
      fields['状态'] = task.status;
    }
    
    // 所属项目（关联字段）
    if (task.projectId) {
      fields['所属项目'] = [task.projectId];
    }
    
    // 所属节点（关联字段）
    if (task.nodeId) {
      fields['所属节点'] = [task.nodeId];
    }
    
    // 负责人（人员字段）
    if (task.assignee) {
      fields['负责人'] = [{ id: task.assignee }];
    }
    
    // 开始日期（时间戳，毫秒）
    if (task.startDate) {
      fields['开始日期'] = new Date(task.startDate).getTime();
    }
    
    // 截止日期（时间戳，毫秒）
    if (task.dueDate) {
      fields['截止日期'] = new Date(task.dueDate).getTime();
    }
    
    // 任务描述
    if (task.description) {
      fields['任务描述'] = task.description;
    }
    
    // 调用飞书 API 创建记录
    const createRes = await fetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${app_token}/tables/${table_id}/records`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({ fields })
      }
    );
    
    const createData = await createRes.json();
    
    if (createData.code !== 0) {
      return res.status(500).json({ 
        success: false, 
        error: '创建任务失败: ' + (createData.msg || JSON.stringify(createData))
      });
    }
    
    return res.status(200).json({
      success: true,
      data: createData.data,
      message: '任务创建成功'
    });
    
  } catch (error) {
    console.error('Create task error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
