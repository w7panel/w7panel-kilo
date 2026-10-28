# Kilo 管理前端

本地测试方式与 `w7panel-mysql` 一样：在 172.16.1.3 启动 Vite 和本地 Kubernetes API 桥接，再用浏览器打开页面。默认读取 `/home/afan/workspace/.kube/218.config` 指向的集群。

```bash
npm ci
npm run dev
```

打开 `http://172.16.1.3:8015/`。页面可管理 Kilo 节点的 6 个配置注解、外部 Peer CRD，并按区域查看配置拓扑；拓扑不显示实时 WireGuard 握手状态。页面上的保存操作会立即写入 218 集群。结束测试后停止 `npm run dev`。

可设置 `KILO_KUBECONFIG` 指向其他集群配置。若面板地址或开发服务地址变化，可分别设置 `KILO_PANEL_ORIGIN`、`KILO_DEV_ORIGIN`。多个本地实例并行时，可设置 `PORT` 和 `KILO_API_PORT`。生产构建使用 `npm run build`，在 W7Panel 内通过宿主注入的 `k8sproxy` 访问集群；宿主凭据需要具备 Peer 的 `list/create/update/delete` 权限。
