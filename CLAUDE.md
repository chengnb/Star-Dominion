# 星域争霸 · Star Dominion — 项目文档

## 项目概述

多人实时太空策略网页游戏。玩家指挥舰队征服行星，与数百人在线对战。权威服务器架构 — 所有游戏逻辑在 Node.js 服务端执行，浏览器端纯 Canvas 渲染 + 输入转发。

- **目标规模**: 数百人同时在线
- **账号系统**: 注册/登录，bcrypt + JWT，进度持久化
- **技术栈**: Node.js + Express + Socket.IO + HTML5 Canvas（无前端框架）

---

## 项目结构

```
Y:\game\
├── CLAUDE.md                    # 本文件 — AI 项目文档
├── README.md                    # 面向玩家的说明文档
├── server/                      # 后端 — 权威游戏服务器
│   ├── package.json             # 依赖: express, socket.io, bcryptjs, jsonwebtoken
│   ├── index.js                 # 入口: Express 静态服务 + Socket.IO + 游戏主循环
│   ├── db.js                    # JSON 文件数据库 (JSONDatabase 类)
│   └── game/
│       ├── constants.js         # 所有游戏常量 (地图/行星/飞船/战斗参数)
│       ├── SpatialGrid.js       # 空间分区网格 — 高效视口裁剪查询
│       └── GameWorld.js         # 游戏世界核心 — 权威游戏逻辑
├── client/                      # 前端 — 无框架，原生 JS + Canvas
│   ├── index.html               # 单页面: 登录界面 + 游戏画布 + UI 面板
│   ├── css/style.css            # 全部样式
│   └── js/
│       ├── main.js              # Socket.IO 连接 & 认证流程 (注册/登录/Token)
│       └── Game.js              # 渲染引擎 / 镜头 / 输入 / HUD / 小地图
└── data/
    └── gamedata.json            # 持久化数据 (自动生成，JSON 格式)
```

---

## 架构关键决策

### 1. 权威服务器 (Authoritative Server)
客户端只是"摄像机 + 输入设备"，不执行任何游戏逻辑。建造、派遣、战斗、资源全部在服务端计算。客户端通过 Socket.IO 发送命令，接收状态更新后渲染。

**优点**: 防作弊、单一真相源、客户端可任意重启而不丢状态。
**代价**: 所有操作有网络延迟（~50ms 一个 tick），需要乐观更新改善体验。

### 2. 状态同步策略
- **首次连接**: `game:init` 发送全量世界状态（150 行星 + 所有舰队 + 玩家列表）
- **每 tick (50ms)**: `game:update` 发送视口内实体 + 脏行星（易主/战斗），`volatile.emit` 抗网络抖动
- **脏标记系统**: 行星发生变更时加入 `dirtyPlanets` Set，无视视口广播，保证小地图实时准确
- **排行榜**: 每 20 ticks (1秒) 独立广播，不使用 volatile（非高频数据）

### 3. 空间分区 (SpatialGrid)
世界 5000×5000，划分 500px 单元格 (10×10 网格)。视口查询仅检索覆盖的单元格，避免 O(n) 全量遍历。
- `insert(id, x, y)` / `remove(id, x, y)` / `move(id, ox, oy, nx, ny)`
- `query(x, y, radius)` 返回圆内所有实体 ID 集合

### 4. 事件委托 (客户端)
行星面板的建造按钮使用事件委托挂在 `#panel-actions` 父容器上，**不在每个 tick 重新绑定**。面板仅在选中行星变化时完整重建 (`_updatePlanetPanel`)，每 tick 只更新文本和按钮状态 (`_refreshPlanetPanel`)。这是踩过的坑 — 高频 innerHTML 会导致闪烁和焦点丢失。

### 5. 持久化方案
使用 JSON 文件而非 SQLite（避免 Windows 原生编译问题）。`JSONDatabase` 类封装 CRUD，每 30 秒自动保存。数据在内存中操作，仅在 save 时序列化写盘。

---

## 已实现功能

| 功能 | 状态 | 位置 |
|------|------|------|
| 用户注册/登录 (bcrypt + JWT) | ✅ | `server/index.js`, `server/db.js` |
| Token 自动登录 | ✅ | `client/js/main.js` (localStorage) |
| 150 行星程序化生成 | ✅ | `server/game/GameWorld.js:_generatePlanets` |
| 三种行星类型 (岩石/气态/类地) | ✅ | `server/game/constants.js` |
| 资源生成 (矿物/能量，按行星类型) | ✅ | `server/game/GameWorld.js:_generateResources` |
| 建造飞船 (侦察机/战斗机/战列舰) | ✅ | `server/game/GameWorld.js:_handleBuildShip` |
| 派遣舰队 (选中行星 → 右键目标) | ✅ | `server/game/GameWorld.js:_handleSendFleet` |
| 舰队航行 (按最慢船速移动) | ✅ | `server/game/GameWorld.js:_moveFleets` |
| 占领中立行星 | ✅ | `server/game/GameWorld.js:_checkArrivals` |
| 攻击敌方行星 (自动战斗) | ✅ | `server/game/GameWorld.js:_battleAtPlanet` |
| 舰队间遭遇战 | ✅ | `server/game/GameWorld.js:_resolveCombat` |
| 行星防御升级 | ✅ | `server/game/GameWorld.js:_handleUpgradeDefense` |
| 排行榜 (按行星数排名) | ✅ | 每 1 秒广播 |
| 聊天系统 (全局) | ✅ | `server/index.js`, `client/js/Game.js` |
| 视口裁剪 (仅发送可见实体) | ✅ | `SpatialGrid` + `getVisibleState` |
| 脏行星广播 (无视视口) | ✅ | `dirtyPlanets` Set |
| Canvas 渲染 (星空视差/行星/舰队/网格) | ✅ | `client/js/Game.js` |
| 镜头控制 (拖拽平移/滚轮缩放/H 回母星) | ✅ | `client/js/Game.js:_bindEvents` |
| 小地图 | ✅ | `client/js/Game.js:_drawMinimap` |
| 行星信息面板 + 建造 UI | ✅ | `client/js/Game.js:_updatePlanetPanel` |
| 资源不足按钮自动禁用 | ✅ | `client/js/Game.js:_refreshPlanetPanel` |
| 舰队到达后合并驻军 | ✅ | `server/game/GameWorld.js:_checkArrivals` |
| 服务器优雅关闭保存 | ✅ | `server/index.js` (SIGINT/SIGTERM) |

---

## 待实现功能 / 已知限制

- [ ] **部分派遣**: 当前右键发送全部驻军，无法选择数量
- [ ] **音效/音乐**: 暂无音频
- [ ] **舰队到达通知**: 舰队抵达目标时无提示
- [ ] **断线重连恢复**: 玩家断线后行星变中立，重连需重新征服
- [ ] **战斗动画**: 战斗静默结算，无视觉反馈
- [ ] **行星自动防御**: 仅有驻军和防御等级，无自动反击
- [ ] **联盟/外交**: 纯 PvP，无联盟系统
- [ ] **科技树**: techLevel 字段已预留但未使用
- [ ] **移动端适配**: 仅桌面端 Canvas 交互，无触屏支持
- [ ] **性能监控**: 无 tick 耗时/在线人数等指标

---

## 开发指南

### 启动服务
```powershell
cd Y:\game\server
node index.js
# 服务运行在 http://localhost:3000
```

### 测试多人
打开多个浏览器标签页，注册不同账号，互相同框对战。

### 关键文件修改指南

| 要改什么 | 改哪里 |
|----------|--------|
| 游戏平衡 (飞船价格/伤害/速度) | `server/game/constants.js` |
| 新增飞船类型 | `constants.js` 添加 SHIP_TYPES 条目；`GameWorld.js` 相关 switch 添加分支 |
| 新增行星类型 | `constants.js` 添加 PLANET_TYPES 条目；客户端 `Game.js` 添加对应颜色 |
| 新增玩家命令 | `server/index.js` 添加 socket.on；`GameWorld.js` 添加 `_handle*` 方法并在 `_processCommands` switch 中注册 |
| 修改 UI/渲染 | `client/js/Game.js`；CSS 在 `client/css/style.css` |
| 修改认证流程 | `server/index.js` socket 事件；`client/js/main.js` |
| 修改持久化格式 | `server/db.js` |

### 数据流

```
浏览器操作 → socket.emit('game:command', cmd)
  → server/index.js: socket.on('game:command')
    → world.enqueueCommand(socketId, cmd)
      → [下一 tick] world._processCommands()
        → world._handleXxx(cmd)  // 修改游戏状态，标记 dirtyPlanets
          → [同一 tick] world.getVisibleState(socketId)
            → socket.volatile.emit('game:update', state)
              → 客户端 Game.onUpdate(data) → 更新 planets/fleets Map → 刷新渲染
```

### 客户端渲染帧

```
requestAnimationFrame 循环:
  1. 平滑缩放 (指数衰减)
  2. 绘制星空背景 (视差滚动)
  3. 绘制网格 + 世界边界
  4. 绘制己方行星连线
  5. 绘制视口内行星 (渐变球体 + 拥有者光环 + 防御标记)
  6. 绘制视口内舰队 (三角箭头 + 数量标签)
  7. 绘制选中指示器 (虚线脉冲光环)
  8. HUD 独立 DOM 层 (不在 Canvas 上)
  9. 小地图独立 Canvas
```

### 常见陷阱

1. **不要在每 tick 修改 DOM innerHTML** — 会导致闪烁和事件丢失。用 textContent 更新文本，用 disabled/classList 改状态。
2. **客户端舰队数量显示** — `Object.assign` 会覆盖 garrison 引用，确保 UI 刷新从 planets Map 读取最新数据。
3. **Socket.IO volatile** — 用于高频状态同步，网络拥塞时自动丢帧，不要用于一次性事件（如命令响应）。
4. **SpatialGrid 边界** — 实体坐标超出 5000×5000 会导致 `_cellIndex` 返回 -1，insert/remove/query 会跳过。

---

## 游戏数值速查

| 参数 | 值 |
|------|-----|
| 世界尺寸 | 5000 × 5000 |
| 行星总数 | 150 |
| 行星最小间距 | 150 |
| 视口半径 | 800 |
| Tick 速率 | 20 TPS (50ms) |
| 保存间隔 | 30 秒 |
| 初始资源 | 500 矿物 / 500 能量 |
| 初始舰队 | 3 侦察机 + 2 战斗机 |

| 飞船 | 造价 | 速度(单位/秒) | HP | 伤害 |
|------|------|-------------|-----|------|
| 侦察机 | 50矿/30能 | 180 | 30 | 5 |
| 战斗机 | 100矿/50能 | 130 | 80 | 15 |
| 战列舰 | 250矿/150能 | 80 | 250 | 40 |

| 行星类型 | 矿物/秒 | 能量/秒 |
|----------|---------|---------|
| 岩石行星 | 3 | 1 |
| 类地行星 | 2 | 2 |
| 气态巨行星 | 1 | 3 |
