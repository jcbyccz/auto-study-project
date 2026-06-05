<div align="center">

# 🎓 Auto Study

**杭州人社学习平台 · 自动刷课脚本**

基于 Playwright 的浏览器自动化工具，自动完成杭州新干线继续教育平台的在线课程学习，
智能选课、自动播放、弹窗确认、学时统计一站式搞定。

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org/)
[![Playwright](https://img.shields.io/badge/Playwright-1.60+-2EAD33.svg)](https://playwright.dev/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

---

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🧠 **智能选课** | 按关键词相关性评分，优先选择与你专业匹配的课程 |
| 🔄 **自动播放** | 检测视频状态，自动播放、处理暂停、应对卡顿 |
| 💬 **弹窗处理** | 自动确认"在线检测"弹窗，无需人工值守 |
| 🔐 **登录持久化** | Cookie 自动保存，重启脚本无需重新登录 |
| 🚫 **课程去重** | 已学课程记录到本地文件，绝不重复刷同一门课 |
| 🖱️ **防挂机检测** | 定时模拟鼠标移动，防止平台检测无操作 |
| 📊 **学时统计** | 实时显示已完成课程数和累计学时 |
| 📑 **自动翻页** | 当前页课程全部学完，自动翻页继续 |
| 🔧 **多策略点击** | 5 种点击策略兜底，应对 Vue SPA 各种点击场景 |

## 📸 运行截图

<!-- 截图占位，后续替换 -->
<table>
  <tr>
    <td align="center"><b>智能选课</b></td>
    <td align="center"><b>自动播放</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/select-course.png" alt="智能选课" width="400"/></td>
    <td><img src="docs/screenshots/auto-play.png" alt="自动播放" width="400"/></td>
  </tr>
  <tr>
    <td align="center"><b>终端日志</b></td>
    <td align="center"><b>学时统计</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/terminal-log.png" alt="终端日志" width="400"/></td>
    <td><img src="docs/screenshots/study-stats.png" alt="学时统计" width="400"/></td>
  </tr>
</table>

## 🚀 快速开始

### 环境要求

- **Node.js** ≥ 18
- **Chrome** 浏览器（已安装在系统中）
- **macOS** / Windows / Linux

### 安装

```bash
# 1. 克隆项目
git clone https://github.com/namebo/auto-study-project.git
cd auto-study-project

# 2. 安装依赖
npm install

# 3. 启动
node auto-study.js
```

或者使用一键启动脚本：

```bash
bash auto-study-start.sh
```

### 首次使用

1. 运行脚本后，Chrome 浏览器会自动打开
2. **手动登录**你的杭州人社学习平台账号
3. 登录成功后回到终端，**按回车键**继续
4. 脚本自动开始选课 → 播放视频 → 学完换课
5. 之后再次运行 **无需重新登录** 🎉

## ⚙️ 配置说明

脚本顶部 `CONFIG` 对象支持自定义：

```javascript
const CONFIG = {
  baseUrl: 'https://learning.hzrs.hangzhou.gov.cn',
  courseUrl: 'https://learning.hzrs.hangzhou.gov.cn/#/Course',

  // 每 30 秒模拟一次鼠标移动（防挂机）
  activityInterval: 30,
  // 每 6 秒检查视频状态和弹窗
  checkInterval: 6,
  // 视频卡住超时（秒），超时后自动刷新
  videoStuckTimeout: 300,
  // 是否无头模式（false = 显示浏览器窗口）
  headless: false,

  // 课程关键词偏好（按优先级排序）
  preferKeywords: [
    '计算机', '软件', '信息技术', 'AI', '大数据', '云计算',
    '网络安全', '信息安全', '编程', '物联网', '5G', '算法',
    // ...
  ],
};
```

### 修改课程偏好

编辑 `preferKeywords` 数组，将你专业的关键词排在前面，脚本会优先选择匹配度高的课程：

```javascript
// 例：建筑行业的同学
preferKeywords: ['建筑', '工程', '施工', '设计', 'BIM', '造价', ...]

// 例：财务行业的同学
preferKeywords: ['会计', '财务', '审计', '税务', '金融', '经济', ...]
```

## 📁 项目结构

```
auto-study-project/
├── auto-study.js          # 主脚本（核心逻辑）
├── auto-study-start.sh    # 一键启动脚本
├── package.json           # 项目依赖
├── auth-state.json        # 登录状态（自动生成，.gitignore）
├── learned-courses.json   # 已学课程记录（自动生成，.gitignore）
├── auto-study.log         # 运行日志（自动生成，.gitignore）
└── browser-data/          # 浏览器数据目录（自动生成，.gitignore）
```

## 🔧 核心流程

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  课程列表页  │────▶│  课程详情页   │────▶│   视频播放页  │
│  选择分类    │     │  点击"立即学习"│     │  自动播放视频 │
│  智能选课    │     │              │     │  弹窗确认在线 │
└─────────────┘     └──────────────┘     └──────┬───────┘
       ▲                                        │
       │             播放完成                     │
       └────────────────────────────────────────┘
```

### 技术细节

| 环节 | 策略 |
|------|------|
| **选课** | 文本特征搜索 + 关键词相关性评分排序 + 已学课程过滤 |
| **点击跳转** | 5 种策略逐个尝试：原生点击 → force 点击 → 内部元素点击 → JS dispatchEvent → 精确 span 点击 |
| **新标签页** | 点击后主动扫描所有页面，对比点击前后差异，不依赖事件监听 |
| **视频播放** | 多播放器类型适配（video / iframe / polyv），自动检测暂停并恢复 |
| **弹窗处理** | 定时扫描 Element UI Dialog / MessageBox / 原生 alert，自动确认 |
| **防卡检测** | 进度卡住 300 秒自动刷新页面，鼠标每 30 秒随机移动 |
| **去重** | 播完课程自动写入 `learned-courses.json`，选课时过滤已学 |

## 📊 学时要求参考

杭州中级职称评审继续教育学时要求（以实际政策为准）：

| 类别 | 每年学时 | 说明 |
|------|----------|------|
| 一般公需 + 行业公需 | ≥ 18 | 必修 |
| 专业科目 | ≥ 60 | 与申报专业相关 |
| **年度合计** | **≥ 90** | |
| 三年合计 | ≥ 180 | 评审前连续 3 年 |

## ❓ 常见问题

<details>
<summary><b>脚本卡住不动了？</b></summary>

按 `Ctrl+C` 终止脚本，登录状态会自动保存。重新运行即可继续，已学的课程不会重复。

</details>

<details>
<summary><b>浏览器没有自动打开？</b></summary>

确认系统中已安装 Chrome 浏览器。脚本使用 `channel: 'chrome'` 调用系统 Chrome。

</details>

<details>
<summary><b>每次重启都要重新登录？</b></summary>

检查 `auth-state.json` 是否存在。如果登录状态过期（通常几天），需要重新登录一次。脚本会自动保存新状态。

</details>

<details>
<summary><b>想选其他专业的课程？</b></summary>

修改脚本顶部的 `preferKeywords` 数组，添加你专业的关键词即可。

</details>

<details>
<summary><b>如何查看已学课程？</b></summary>

查看 `learned-courses.json` 文件，里面记录了所有已完成的课程名和学习日期。

</details>

<details>
<summary><b>支持无头模式吗？</b></summary>

设置 `headless: true` 即可，但建议保留浏览器窗口以便观察运行状态和首次登录。

</details>

## 📝 更新日志

### v3.6
- ✨ 新增已学课程去重，记录到 `learned-courses.json`
- ✨ 当前页全部已学时自动翻页
- ✨ 选课时双重过滤，确保不重复

### v3.5
- 🐛 修复点击课程后脚本挂死问题
- 🔧 移除 `Promise.allSettled` + `context.on('page')` 模式
- 🔧 改用"点击后主动扫描所有页面"方式检测跳转
- 🔧 5 种点击策略逐个尝试

### v3
- ✅ 登录持久化（storageState 替代 launchPersistentContext）
- ✅ 智能导航，不再重复弹出页面
- ✅ 增强视频播放，支持多播放器类型

## ⚖️ 免责声明

本项目仅供学习交流使用，请确保你的使用行为符合平台规定和相关法律法规。使用本脚本产生的一切后果由使用者自行承担。

## 📄 License

[MIT](LICENSE)
