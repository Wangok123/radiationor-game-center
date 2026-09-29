# Unity 程序员个人网站

这是一个适合 GitHub Pages 的零依赖静态网站。网站由 `src/content` 下的 Markdown 文件生成。

## 本地构建

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build.ps1
```

构建后打开 `dist/index.html` 即可预览，不需要启动本地服务器。

## 添加笔记

当前网站以学习笔记为主。正式作品集页面会保留入口，但在作品整理完成前显示占位提示。



复制 `src/content/works` 或 `src/content/notes` 中的 Markdown 文件，保留头部字段并修改内容，然后重新运行构建命令。

## 部署

将仓库推送到 GitHub 默认分支。内置工作流会把 `dist` 发布到 GitHub Pages，在仓库设置中将 Pages 来源选择为 **GitHub Actions**。



## 自动部署

推送到 `main` 后，GitHub Actions 会自动构建并部署到 GitHub Pages。

本仓库已启用本地 `pre-push` 钩子：每次 `git push` 前都会运行构建；如果构建失败，推送会被取消。新电脑克隆仓库后执行一次：

```powershell
git config core.hooksPath .githooks
```
