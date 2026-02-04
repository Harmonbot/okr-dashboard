# 新品OKR项目管理系统 - 部署指南

## 📁 项目结构

```
okr-dashboard/
├── index.html          # 前端页面
├── api/
│   └── lark.js         # 飞书 API 代理
├── vercel.json         # Vercel 配置
└── README.md           # 部署说明
```

## 🚀 部署步骤

### 第一步：准备飞书应用凭证

1. 打开 [飞书开放平台](https://open.feishu.cn/app)
2. 进入你的自建应用
3. 在「凭证与基础信息」页面获取：
   - **App ID**
   - **App Secret**

### 第二步：部署到 Vercel

#### 方法 A：通过 GitHub（推荐）

1. 将此项目上传到 GitHub 仓库

2. 打开 [Vercel](https://vercel.com) 并用 GitHub 登录

3. 点击 **「New Project」** → 导入你的仓库

4. 在部署配置中，添加环境变量：
   - `LARK_APP_ID` = 你的飞书 App ID
   - `LARK_APP_SECRET` = 你的飞书 App Secret

5. 点击 **「Deploy」**

6. 部署完成后获得访问链接，如：`https://your-project.vercel.app`

#### 方法 B：通过 Vercel CLI

```bash
# 安装 Vercel CLI
npm i -g vercel

# 登录
vercel login

# 部署
cd okr-dashboard
vercel

# 添加环境变量
vercel env add LARK_APP_ID
vercel env add LARK_APP_SECRET

# 重新部署
vercel --prod
```

### 第三步：嵌入飞书仪表盘

1. 打开飞书多维表格：
   `https://ox5c0vhqom6.feishu.cn/base/N5OqbwkO1a2PbpsaM05ckGrMnxg`

2. 进入 **「OKR总览」** 仪表盘

3. 点击 **「+ 添加组件」**

4. 选择 **「内嵌网页」**

5. 输入你的 Vercel 部署链接

6. 调整组件大小（建议全宽显示）

7. 保存

## ⚙️ 配置说明

### 环境变量

| 变量名 | 说明 | 示例 |
|--------|------|------|
| LARK_APP_ID | 飞书应用 ID | cli_xxxxxxxxxxxx |
| LARK_APP_SECRET | 飞书应用密钥 | xxxxxxxxxxxxxxxx |

### 飞书应用权限

确保你的飞书应用已开启以下权限：

- `bitable:app:readonly` - 读取多维表格
- `bitable:record:read` - 读取记录

### 多维表格 Token

当前配置的多维表格 token：`N5OqbwkO1a2PbpsaM05ckGrMnxg`

如需更换，修改 `index.html` 中的 `APP_TOKEN` 变量。

## 🔄 数据同步

- 页面加载时自动获取最新数据
- 每 5 分钟自动刷新
- 可手动点击「刷新」按钮

## 📊 功能说明

### 产品进度视窗
- 卡片视图：展示所有产品当前阶段
- 管道视图：按流程阶段分列展示
- 点击卡片查看详情

### 人员任务视窗
- 按团队成员展示任务分配
- 任务完成率统计
- 任务状态筛选

## 🔧 常见问题

### Q: 部署后显示"加载失败"？
A: 检查环境变量是否正确配置，确保飞书应用权限已开启。

### Q: 数据不显示？
A: 确认多维表格已授权给飞书应用，且表名与代码中一致。

### Q: 嵌入飞书后显示空白？
A: 检查 Vercel 域名是否被飞书允许嵌入，可能需要在飞书后台配置可信域名。

## 📝 更新日志

- v1.0.0 - 初始版本
  - 产品进度视窗（卡片/管道视图）
  - 人员任务视窗
  - 飞书 API 实时同步
  - 自动刷新功能
