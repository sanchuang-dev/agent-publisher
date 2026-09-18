# Frontend Product Design Specification

Status: active product design baseline  
Phase: POC / MVP  
Parent product contract: [PRD.md](./PRD.md)

This document defines the product-facing frontend experience for Agent Publisher. It is a design contract for prototype and implementation work.

It owns the frontend interaction model, information architecture, page responsibilities, user-visible states, and product presentation. It does not define implementation details that belong in code or work-item scope that belongs in GitHub Issues.

## 1. Experience thesis

Agent Publisher should feel like:

> I assigned work to an AI employee, and it is doing the job for me.

It should **not** primarily feel like:

- a chat application;
- an AI writing tool;
- a prompt playground;
- a traditional admin dashboard;
- a workflow-builder product.

The user's mental model is delegation, supervision, intervention when necessary, and approval of final delivery.

## 2. Visible roles

The MVP presents two distinct AI worker roles.

### Content Secretary

Responsible for:

- understanding the publishing brief;
- preparing copy;
- preparing images;
- preparing video when requested;
- generating titles, tags, covers, and platform-ready material;
- adapting material before handoff to publishing.

### Publishing Secretary

Responsible for:

- opening the target publishing environment;
- checking login/session state;
- operating the browser;
- uploading material;
- filling platform forms;
- requesting human takeover when identity verification is required;
- performing pre-publish checks;
- requesting approval;
- publishing after approval;
- collecting result evidence.

These roles are user-facing product concepts. The UI should make their handoff visible without turning the product into a multi-agent chat room.

## 3. Primary desktop layout

Desktop-first. Design the main prototype around a 1440px-wide viewport.

The key task detail experience uses three regions:

```text
┌─────────────────────────────────────────────────────────────┐
│ Agent Publisher                              Task status      │
├────────────────┬─────────────────────────────┬───────────────┤
│ Task context   │ Work timeline / execution   │ Current work  │
│                │                             │               │
│ brief          │ Content Secretary           │ material      │
│ target         │ Publishing Secretary        │ preview       │
│ platform       │ live progress               │ browser       │
│ instructions   │ takeover / approval events  │ evidence      │
└────────────────┴─────────────────────────────┴───────────────┘
```

The center column is the product's emotional center: the user should be able to glance at it and understand what the AI employee is doing now.

The right side changes according to task state:

- material preview during creation;
- browser live view during publishing;
- approval summary before publication;
- evidence/result after completion.

## 4. Core screens

### 4.1 Task Home

Purpose: assign work and supervise current work.

Primary action:

> 交代一个任务

Show lightweight task groups:

- 等我处理
- 正在执行
- 已完成

Each task card should communicate:

- task intent;
- target platform;
- current worker / current step;
- current status;
- whether user intervention is required.

Do not begin with analytics, charts, token usage, or system health panels.

### 4.2 Create / Assign Task

The input experience should feel like giving instructions to an employee.

Required inputs:

- task brief / source content;
- target platform;
- optional source files or links;
- optional content requirements.

The user may start from a short instruction such as:

> 给公司这个产品做一篇小红书介绍。

Do not require the user to configure an agent graph, model chain, browser strategy, or tool list.

### 4.3 Task Detail

This is the primary product screen.

Left: task context  
Center: worker timeline  
Right: context-sensitive work surface

The timeline should clearly show handoff between the two visible workers.

Example:

```text
内容秘书
✓ 理解需求
✓ 生成文案
✓ 生成 6 张图片
✓ 完成平台适配

执行秘书
✓ 打开小红书
✓ 检查登录状态
✓ 上传图片
✓ 填写标题与正文
● 等待发布批准
```

The timeline should not expose low-level tool calls by default. Technical details may be available behind an expandable diagnostic affordance later, but they are not the main experience.

### 4.4 Material Review

Show the current Material Pack in a platform-relevant preview.

For Xiaohongshu, support at least:

- title;
- body copy;
- tags;
- image sequence;
- cover;
- video when the task requests a video post.

Allow lightweight edits and targeted regeneration of one material item.

Do not attempt to reproduce Canva or a full nonlinear editor in the MVP.

### 4.5 Browser Live View

When the Publishing Secretary is operating the platform, show:

- target platform;
- current browser step;
- login/session status;
- browser live view when available;
- action to take over control when required.

The experience should resemble observing an employee operating a browser, not debugging Playwright.

### 4.6 Human Takeover

Identity verification is a first-class product state.

When required, clearly communicate:

> 执行秘书已让出控制，请完成登录 / 扫码 / 2FA / 设备验证。

The user should be able to complete the verification directly in the browser view when the runtime supports it.

After the system detects success, control should naturally return to the Publishing Secretary.

Avoid awkward extra confirmation steps when the state transition can be detected reliably.

### 4.7 Publish Approval

Before an irreversible publish action, show a compact review card containing:

- platform;
- account/profile identity;
- title;
- cover / representative media;
- copy summary;
- tags;
- relevant warnings or missing items.

Primary actions:

- 批准发布
- 返回修改

The approval screen should feel like an employee presenting completed work for sign-off.

### 4.8 Result / Evidence

On success, show:

- publication status;
- resulting URL or identifier when available;
- platform confirmation;
- screenshot/evidence when available;
- completion time.

On failure, show:

- where the flow stopped;
- concise reason;
- whether the user can retry, resume, or take over.

Do not expose raw stack traces as the primary error presentation.

### 4.9 Identity / Profile Management

Keep this deliberately small.

Example identities:

- 公司小红书
- 公司抖音
- 公司公众号

Show only what is operationally useful:

- platform;
- display name;
- login/session state;
- last verified time;
- re-login / reconnect action.

Do not build password management.

## 5. User-visible task states

Use a small, stable language set.

Recommended Chinese labels:

- 准备中
- 内容制作中
- 等待登录
- 正在准备发布
- 等待批准
- 正在发布
- 已完成
- 需要处理
- 失败

Avoid surfacing internal terms such as planner, tool call, context window, token count, CDP, selector, or chain-of-thought in normal product UI.

## 6. Visual direction

The product should feel:

- professional;
- calm;
- modern;
- competent;
- observably active;
- human-supervised rather than fully opaque.

Avoid:

- generic SaaS admin dashboard aesthetics;
- ChatGPT clone layouts;
- oversized chat bubbles as the primary structure;
- cyberpunk / hacker visual language;
- excessive gradients and glowing AI effects;
- cartoonish multi-agent roleplay.

The two worker roles may use distinct avatars/icons/identity treatments, but they should remain restrained and product-like.

## 7. Prototype priority

Open Design should produce these five core desktop screens first:

1. Task Home
2. Task Detail — work in progress
3. Human Takeover / Login
4. Publish Approval
5. Completed Result / Evidence

The Task Detail screen is the highest-priority artifact and should establish the overall design language.

A secondary Material Review state may be shown as a variant of Task Detail rather than a separate application area.

## 8. Responsive expectation

The MVP is desktop-first.

- Primary design target: 1440px desktop.
- Reasonable support target: 1280px desktop/laptop.
- Mobile is not a first-MVP design requirement.

Do not compromise the desktop supervision experience to prematurely optimize for mobile.

## 9. What not to design yet

Do not spend prototype effort on:

- analytics dashboards;
- billing;
- organization management;
- complex permissions;
- workflow editors;
- model/provider configuration centers;
- scheduling calendars;
- large settings centers;
- team collaboration;
- multi-account matrix operations;
- detailed developer consoles.

These may exist later only when product evidence justifies them.

## 10. Prototype acceptance

The prototype is successful when a viewer can understand, without explanation:

1. what task was assigned;
2. which AI worker is currently responsible;
3. what has already been completed;
4. what the system is doing now;
5. whether the user needs to intervene;
6. what content will be published;
7. what irreversible action awaits approval;
8. whether the final publication succeeded.
