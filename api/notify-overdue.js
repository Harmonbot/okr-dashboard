// /api/notify-overdue.js - 逾期任务飞书通知 (Vercel Cron)
const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
const APP_TOKEN = 'N5OqbwkO1a2PbpsaM05ckGrMnxg';
const TASKS_TABLE = 'tblFwmxmjRJPzVmV';
const MEMBERS_TABLE = 'tbl1sP46C4DSjSYj';
const PROJECTS_TABLE = 'tblYM02NyVj3rUkR';
const DASHBOARD_URL = 'https://okr-dashboard-eight.vercel.app';

async function getTenantToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET })
  });
  const data = await res.json();
  return data.tenant_access_token;
}

async function fetchAllRecords(token, tableId) {
  let records = [];
  let pageToken = null;
  do {
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?page_size=500${pageToken ? '&page_token=' + pageToken : ''}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    if (data.code !== 0) throw new Error(`Lark API error: ${data.msg}`);
    records = records.concat(data.data?.items || []);
    pageToken = data.data?.has_more ? data.data.page_token : null;
  } while (pageToken);
  return records;
}

function parseLarkDate(val) {
  if (!val) return null;
  // 飞书日期可能是毫秒时间戳或 ISO 字符串
  if (typeof val === 'number') return new Date(val);
  return new Date(val);
}

function extractLarkUser(field) {
  if (!field) return null;
  if (Array.isArray(field) && field[0]) {
    return { id: field[0].id, name: field[0].name };
  }
  if (field.id) return { id: field.id, name: field.name };
  return null;
}

function extractLinkedId(field) {
  if (!field) return null;
  if (field.link_record_ids?.[0]) return field.link_record_ids[0];
  if (Array.isArray(field) && field[0]?.record_ids?.[0]) return field[0].record_ids[0];
  if (Array.isArray(field) && typeof field[0] === 'string') return field[0];
  return null;
}

async function sendCardMessage(token, openId, card) {
  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: 'interactive',
      content: JSON.stringify(card)
    })
  });
  return res.json();
}

function buildOverdueCard(memberName, overdueTasks, taskStats) {
  const taskRows = overdueTasks.slice(0, 5).map(t => {
    const overdueDays = Math.ceil((Date.now() - new Date(t.dueDate).getTime()) / (1000 * 60 * 60 * 24));
    return {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**${t.name}**` } },
        { is_short: true, text: { tag: 'lark_md', content: `${t.projectName || '未关联项目'}` } },
        { is_short: true, text: { tag: 'lark_md', content: `${t.priority || 'P2'}` } },
        { is_short: true, text: { tag: 'lark_md', content: `逾期 **${overdueDays}** 天` } }
      ]
    };
  });

  const extraNote = overdueTasks.length > 5 
    ? [{ tag: 'div', text: { tag: 'lark_md', content: `...还有 ${overdueTasks.length - 5} 项逾期任务` } }]
    : [];

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `⚠️ 逾期任务提醒 (${overdueTasks.length}项)` },
      template: 'red'
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `**${memberName}**，你有 **${overdueTasks.length}** 项任务已逾期，请及时处理：` }
      },
      { tag: 'hr' },
      // 表头
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: '**任务**' } },
          { is_short: true, text: { tag: 'lark_md', content: '**项目**' } },
          { is_short: true, text: { tag: 'lark_md', content: '**优先级**' } },
          { is_short: true, text: { tag: 'lark_md', content: '**逾期天数**' } }
        ]
      },
      ...taskRows,
      ...extraNote,
      { tag: 'hr' },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `📊 任务总览：进行中 ${taskStats.inProgress} | 待开始 ${taskStats.pending} | 已完成 ${taskStats.completed} | 逾期 ${overdueTasks.length}` }
      },
      {
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '查看项目管理面板' },
          url: DASHBOARD_URL,
          type: 'primary'
        }]
      }
    ]
  };
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const token = await getTenantToken();

    // 1. 获取所有任务、成员、项目
    const [taskRecords, memberRecords, projectRecords] = await Promise.all([
      fetchAllRecords(token, TASKS_TABLE),
      fetchAllRecords(token, MEMBERS_TABLE),
      fetchAllRecords(token, PROJECTS_TABLE)
    ]);

    // 2. 建立项目 ID → 名称映射
    const projectMap = {};
    projectRecords.forEach(r => {
      projectMap[r.record_id] = r.fields['项目名称'] || '';
    });

    // 3. 建立成员信息映射（open_id → 成员信息）
    const memberMap = {};
    memberRecords.forEach(r => {
      const larkUser = extractLarkUser(r.fields['飞书用户']);
      if (larkUser?.id) {
        let name = r.fields['姓名'];
        if (Array.isArray(name)) name = name.map(n => n.text || n).join('');
        memberMap[larkUser.id] = { name: name || larkUser.name, openId: larkUser.id };
      }
    });

    // 4. 解析任务，找出逾期任务
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    
    // 按负责人分组
    const overdueByMember = {}; // openId → [tasks]
    const statsByMember = {};   // openId → {inProgress, pending, completed}

    taskRecords.forEach(r => {
      const status = r.fields['状态'] || '待开始';
      const assignee = extractLarkUser(r.fields['负责人']);
      if (!assignee?.id) return;

      const openId = assignee.id;

      // 初始化统计
      if (!statsByMember[openId]) {
        statsByMember[openId] = { inProgress: 0, pending: 0, completed: 0 };
      }

      if (status === '已完成') {
        statsByMember[openId].completed++;
        return;
      }
      if (status === '进行中') statsByMember[openId].inProgress++;
      else statsByMember[openId].pending++;

      // 检查是否逾期
      const dueDate = parseLarkDate(r.fields['截止日期']);
      if (!dueDate || dueDate >= now) return;

      let taskName = r.fields['任务名称'] || '';
      if (Array.isArray(taskName)) taskName = taskName.map(n => n.text || n).join('');
      
      const projectId = extractLinkedId(r.fields['所属项目']);
      const priority = (r.fields['优先级'] || 'P2').replace(/-.*$/, '');

      if (!overdueByMember[openId]) overdueByMember[openId] = [];
      overdueByMember[openId].push({
        name: taskName,
        dueDate: dueDate.toISOString().split('T')[0],
        priority,
        projectName: projectId ? projectMap[projectId] : '',
        status
      });
    });

    // 5. 发送通知
    const results = [];
    for (const [openId, overdueTasks] of Object.entries(overdueByMember)) {
      if (overdueTasks.length === 0) continue;

      const memberInfo = memberMap[openId];
      if (!memberInfo) continue;

      // 按优先级排序：P0 > P1 > P2 > P3
      overdueTasks.sort((a, b) => (a.priority || 'P2').localeCompare(b.priority || 'P2'));

      const card = buildOverdueCard(
        memberInfo.name,
        overdueTasks,
        statsByMember[openId] || { inProgress: 0, pending: 0, completed: 0 }
      );

      const sendResult = await sendCardMessage(token, openId, card);
      results.push({
        member: memberInfo.name,
        openId,
        overdueCount: overdueTasks.length,
        sent: sendResult.code === 0,
        error: sendResult.code !== 0 ? sendResult.msg : undefined
      });
    }

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      notified: results.length,
      details: results,
      totalOverdueTasks: Object.values(overdueByMember).reduce((s, t) => s + t.length, 0)
    });

  } catch (error) {
    console.error('Notify overdue error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
