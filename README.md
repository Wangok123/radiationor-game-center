# Unity 程序员个人网站

这是一个适合 GitHub Pages 的零依赖静态网站。网站由 `src/content` 下的 Markdown 文件生成。

## 本地构建

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build.ps1
```

构建后打开 `dist/index.html` 即可预览，不需要启动本地服务器。

## 添加作品或笔记

复制 `src/content/works` 或 `src/content/notes` 中的 Markdown 文件，保留头部字段并修改内容，然后重新运行构建命令。

## 部署

将仓库推送到 GitHub 默认分支。内置工作流会把 `dist` 发布到 GitHub Pages，在仓库设置中将 Pages 来源选择为 **GitHub Actions**。

