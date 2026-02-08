// /api/notify-overdue.js - 逾期+临期任务飞书通知 (Vercel Cron)
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
  if (typeof val === 'number') return new Date(val);
  return new Date(val);
}

function extractLarkUser(field) {
  if (!field) return null;
  if (Array.isArray(field) && field[0]) return { id: field[0].id, name: field[0].name };
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

// 分类任务紧急程度
function classifyTask(daysRemaining) {
  if (daysRemaining < 0) return { level: 'overdue', label: `逾期 ${Math.abs(daysRemaining)} 天`, color: '🔴', sort: 0 };
  if (daysRemaining === 0) return { level: 'today', label: '今天截止', color: '🔴', sort: 1 };
  if (daysRemaining === 1) return { level: 'urgent', label: '明天截止', color: '🟠', sort: 2 };
  if (daysRemaining <= 3) return { level: 'warning', label: `${daysRemaining} 天后截止`, color: '🟡', sort: 3 };
  if (daysRemaining <= 5) return { level: 'notice', label: `${daysRemaining} 天后截止`, color: '🔵', sort: 4 };
  return null;
}

function buildReminderCard(memberName, taskGroups, taskStats) {
  const elements = [];
  const totalCount = taskGroups.reduce((s, g) => s + g.tasks.length, 0);

  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**${memberName}**，你有 **${totalCount}** 项任务需要关注：` }
  });

  for (const group of taskGroups) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `${group.icon} **${group.title}**（${group.tasks.length}项）` }
    });

    const showTasks = group.tasks.slice(0, 5);
    for (const t of showTasks) {
      elements.push({
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `${t.classification.color} **${t.name}**` } },
          { is_short: true, text: { tag: 'lark_md', content: `${t.projectName || '-'}` } },
          { is_short: true, text: { tag: 'lark_md', content: `${t.priority}` } },
          { is_short: true, text: { tag: 'lark_md', content: `${t.classification.label}` } }
        ]
      });
    }
    if (group.tasks.length > 5) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `...还有 ${group.tasks.length - 5} 项` }
      });
    }
  }

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `📊 任务总览：进行中 ${taskStats.inProgress} | 待开始 ${taskStats.pending} | 已完成 ${taskStats.completed}` }
  });
  elements.push({
    tag: 'action',
    actions: [{
      tag: 'button',
      text: { tag: 'plain_text', content: '查看项目管理面板' },
      url: DASHBOARD_URL,
      type: 'primary'
    }]
  });

  const topLevel = taskGroups[0]?.level || 'notice';
  const headerTemplate = (topLevel === 'overdue' || topLevel === 'today') ? 'red'
    : topLevel === 'urgent' ? 'orange'
    : topLevel === 'warning' ? 'yellow'
    : 'blue';

  const headerTitle = (topLevel === 'overdue' || topLevel === 'today')
    ? `⚠️ 逾期/紧急任务提醒（${totalCount}项）`
    : `📋 临期任务提醒（${totalCount}项）`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: headerTitle },
      template: headerTemplate
    },
    elements
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const token = await getTenantToken();

    const [taskRecords, memberRecords, projectRecords] = await Promise.all([
      fetchAllRecords(token, TASKS_TABLE),
      fetchAllRecords(token, MEMBERS_TABLE),
      fetchAllRecords(token, PROJECTS_TABLE)
    ]);

    const projectMap = {};
    projectRecords.forEach(r => {
      projectMap[r.record_id] = r.fields['项目名称'] || '';
    });

    const memberMap = {};
    memberRecords.forEach(r => {
      const larkUser = extractLarkUser(r.fields['飞书用户']);
      if (larkUser?.id) {
        let name = r.fields['姓名'];
        if (Array.isArray(name)) name = name.map(n => n.text || n).join('');
        memberMap[larkUser.id] = { name: name || larkUser.name, openId: larkUser.id };
      }
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const alertsByMember = {};
    const statsByMember = {};

    taskRecords.forEach(r => {
      const status = r.fields['状态'] || '待开始';
      const assignee = extractLarkUser(r.fields['负责人']);
      if (!assignee?.id) return;

      const openId = assignee.id;
      if (!statsByMember[openId]) {
        statsByMember[openId] = { inProgress: 0, pending: 0, completed: 0 };
      }

      if (status === '已完成') {
        statsByMember[openId].completed++;
        return;
      }
      if (status === '进行中') statsByMember[openId].inProgress++;
      else statsByMember[openId].pending++;

      const dueDate = parseLarkDate(r.fields['截止日期']);
      if (!dueDate) return;

      const dueDateNorm = new Date(dueDate);
      dueDateNorm.setHours(0, 0, 0, 0);
      const daysRemaining = Math.ceil((dueDateNorm - today) / (1000 * 60 * 60 * 24));

      const classification = classifyTask(daysRemaining);
      if (!classification) return;

      let taskName = r.fields['任务名称'] || '';
      if (Array.isArray(taskName)) taskName = taskName.map(n => n.text || n).join('');

      const projectId = extractLinkedId(r.fields['所属项目']);
      const priority = (r.fields['优先级'] || 'P2').replace(/-.*$/, '');

      if (!alertsByMember[openId]) alertsByMember[openId] = [];
      alertsByMember[openId].push({
        name: taskName,
        dueDate: dueDateNorm.toISOString().split('T')[0],
        priority,
        projectName: projectId ? projectMap[projectId] : '',
        classification,
        daysRemaining
      });
    });

    const results = [];
    for (const [openId, tasks] of Object.entries(alertsByMember)) {
      if (tasks.length === 0) continue;
      const memberInfo = memberMap[openId];
      if (!memberInfo) continue;

      tasks.sort((a, b) => a.classification.sort - b.classification.sort || (a.priority || '').localeCompare(b.priority || ''));

      const groupDefs = [
        { level: 'overdue', icon: '🔴', title: '已逾期', filter: t => t.classification.level === 'overdue' },
        { level: 'today', icon: '⏰', title: '今天截止', filter: t => t.classification.level === 'today' },
        { level: 'urgent', icon: '🟠', title: '明天截止', filter: t => t.classification.level === 'urgent' },
        { level: 'warning', icon: '🟡', title: '3天内截止', filter: t => t.classification.level === 'warning' },
        { level: 'notice', icon: '🔵', title: '5天内截止', filter: t => t.classification.level === 'notice' }
      ];

      const taskGroups = groupDefs
        .map(g => ({ ...g, tasks: tasks.filter(g.filter) }))
        .filter(g => g.tasks.length > 0);

      if (taskGroups.length === 0) continue;

      const card = buildReminderCard(
        memberInfo.name,
        taskGroups,
        statsByMember[openId] || { inProgress: 0, pending: 0, completed: 0 }
      );

      const sendResult = await sendCardMessage(token, openId, card);
      results.push({
        member: memberInfo.name,
        openId,
        overdue: tasks.filter(t => t.classification.level === 'overdue').length,
        today: tasks.filter(t => t.classification.level === 'today').length,
        upcoming: tasks.filter(t => ['urgent', 'warning', 'notice'].includes(t.classification.level)).length,
        total: tasks.length,
        sent: sendResult.code === 0,
        error: sendResult.code !== 0 ? sendResult.msg : undefined
      });
    }

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      notified: results.length,
      details: results
    });

  } catch (error) {
    console.error('Notify overdue error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
