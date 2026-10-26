---
name: kilo-k3s-cilium-install
description: 在已运行 Cilium 的 k3s 集群安装或排查 Kilo WireGuard，选择 Cilium 附加模式清单并验证 DaemonSet；不适用于替换现有 CNI。
---

# 在 k3s + Cilium 上安装 Kilo

先将 `KUBECONFIG` 设为目标集群配置文件，并确认节点和当前 CNI。以下命令中的 Kilo checkout 路径由目标环境决定，不把 218 的地址当作通用配置。安装前读目标版本的 `manifests/kilo-k3s-cilium.yaml` 和 `manifests/crds.yaml`。

## 安装

1. 用 `kubectl --kubeconfig "$KUBECONFIG" get nodes -o wide` 和 `kubectl --kubeconfig "$KUBECONFIG" -n kube-system get ds cilium` 确认目标集群及 Cilium 状态；检查现有 `kilo` DaemonSet、Pod 和事件。Kilo 需要节点的 WireGuard 内核支持，跨网络节点还需要 UDP 51820 可达。
2. 已运行 Cilium 时使用仓库的 `manifests/kilo-k3s-cilium.yaml`。该清单使用 `--cni=false --compatibility=cilium`，不含 `install-cni` 初始化容器。不要套用 `kilo-k3s.yaml`：它的 `install-cni` 会执行 `rm -f /host/etc/cni/net.d/*`，删除 Cilium 的 CNI 配置。若现有 DaemonSet 用错清单，先核对切换后的完整变更范围，再将它改为 Cilium 清单。
3. 在 Kilo checkout 中安装 CRD 和清单：

   ```sh
   kubectl --kubeconfig "$KUBECONFIG" apply -f manifests/crds.yaml
   kubectl --kubeconfig "$KUBECONFIG" apply -f manifests/kilo-k3s-cilium.yaml
   kubectl --kubeconfig "$KUBECONFIG" -n kube-system rollout status ds/kilo --timeout=180s
   ```

4. 检查 `kubectl --kubeconfig "$KUBECONFIG" -n kube-system get ds kilo cilium` 均 Ready；检查 Kilo Pod 的 init 容器只有 `generate-kubeconfig`，主容器参数含 `--cni=false` 和 `--compatibility=cilium`；读 `kubectl ... logs <kilo-pod> -c kilo --tail=100`，确认 mesh 启动且没有持续报错。需要节点互联时，再验证 WireGuard 握手及实际跨节点流量；单节点 Pod Ready 只证明本机 agent 已运行。

## 启动卡住时

- 先看 `kubectl ... describe pod <kilo-pod>`、`kubectl ... get events --field-selector involvedObject.name=<kilo-pod>` 和 init 容器状态。`Init:0/2`、空 `imageID` 或没有事件，不能单独证明镜像下载慢。
- 若事件或节点运行时日志明确显示镜像拉取超时，再检查目标节点能否拉取镜像。需要使用私有/国内仓库时，可把同一版本和架构的镜像镜像到可达仓库，并同时修改 DaemonSet 中主容器和 init 容器的镜像；若决定从源码构建，则核对 checkout、Dockerfile、目标架构和镜像 tag 后再推送。不要仅因 Pod Pending 就重新构建。
- 在 218 的一次排查中，错误部署了独立 CNI 清单，Pod 停在 `Init:0/2` 且无事件；切换到 `kilo-k3s-cilium.yaml` 后，新 Pod 很快 `1/1 Running`，Cilium 也保持 `1/1 Ready`，未构建或推送镜像。旧 Pod 当时为何未启动容器没有得到独立证实，不能把这一现象归因为镜像拉取。

修改集群网络清单前，明确现有 CNI 和待应用清单会改写的节点文件；如果两者冲突，先说明方案并取得用户确认。
