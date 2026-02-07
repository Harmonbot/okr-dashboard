// Vercel Serverless Function - 飞书 OAuth 回调处理
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  try {
    const { code } = req.query;
    
    if (!code) {
      return res.status(400).json({ success: false, error: '缺少授权码' });
    }
    
    const APP_ID = process.env.LARK_APP_ID;
    const APP_SECRET = process.env.LARK_APP_SECRET;
    
    if (!APP_ID || !APP_SECRET) {
      return res.status(500).json({ success: false, error: '服务器配置错误' });
    }
    
    // 1. 获取 app_access_token
    const appTokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
    });
    const appTokenData = await appTokenRes.json();
    
    if (appTokenData.code !== 0) {
      return res.status(500).json({ success: false, error: '获取应用凭证失败: ' + appTokenData.msg });
    }
    
    // 2. 用 code 换取 user_access_token
    const userTokenRes = await fetch('https://open.feishu.cn/open-apis/authen/v1/oidc/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appTokenData.app_access_token}`
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: code
      })
    });
    const userTokenData = await userTokenRes.json();
    
    if (userTokenData.code !== 0) {
      return res.status(500).json({ success: false, error: '获取用户凭证失败: ' + userTokenData.msg });
    }
    
    const { access_token, refresh_token, expires_in } = userTokenData.data;
    
    // 3. 获取用户信息
    const userInfoRes = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${access_token}`
      }
    });
    const userInfoData = await userInfoRes.json();
    
    if (userInfoData.code !== 0) {
      return res.status(500).json({ success: false, error: '获取用户信息失败: ' + userInfoData.msg });
    }
    
    const userInfo = userInfoData.data;
    
    // 返回用户信息
    return res.status(200).json({
      success: true,
      data: {
        user: {
          open_id: userInfo.open_id,
          union_id: userInfo.union_id,
          user_id: userInfo.user_id,
          name: userInfo.name,
          en_name: userInfo.en_name,
          avatar_url: userInfo.avatar_url,
          email: userInfo.email,
          mobile: userInfo.mobile
        },
        access_token,
        refresh_token,
        expires_in
      }
    });
    
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
