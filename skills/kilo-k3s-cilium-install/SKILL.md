---
name: kilo-k3s-cilium-install
description: 在已运行 Cilium 的 k3s 集群安装、连接或排查 Kilo WireGuard，选择 Cilium 附加模式清单并验证 Peer 连通性；不适用于替换现有 CNI。
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

## 从外部 Linux 连接并验证

1. 确认客户端能访问 Kubernetes API，且节点公布的 WireGuard Endpoint 从客户端可达，UDP 51820 已放行并正确转发。用 `kubectl --kubeconfig "$KUBECONFIG" get node <node> -o yaml` 检查 `kilo.squat.ai/force-endpoint`；仅在需要且得到授权时设置公网 `host:port`，记录旧值并在临时测试后恢复。注解不会自动开放防火墙或配置 NAT。
2. 安装与目标集群兼容的 `kgctl`。客户端需 Linux 和 `CAP_NET_ADMIN`；选择未占用的 Peer 名和地址，避免与已有 Peer 或本地网段冲突。`kgctl connect` 遇到同名现有 Peer 不会更新公钥。实际 Service CIDR 必须从目标集群配置确认，不能直接照搬 218 的网段。
3. 在客户端运行以下命令并保持进程运行；`--allowed-ip` 是客户端地址，`--allowed-ips` 是额外允许访问的集群网段：

   ```sh
   sudo kgctl --kubeconfig "$KUBECONFIG" connect <unique-test-peer> \
     --allowed-ip <free-peer-ip>/32 --allowed-ips <service-cidr>
   ```

4. 在客户端另开终端依次检查 `sudo wg show kilo0` 的最新握手与收发计数、`ip route get <pod-ip>` 和 `ip route get <service-ip>` 是否走 `kilo0`，再用 `ping` 或 `nc -vz -w 3 <pod-ip> <port>` 测试实际运行的 Pod，最后测试对应的 Service ClusterIP 和端口。新 Peer 创建后 `kgctl` 的首次同步可能早于 Kubernetes 对象可见；出现 `did not find any peer` 时，等待默认 30 秒的下一次同步再判断。握手成功不代表 Pod 或 Service 可达；目标端口、NetworkPolicy 和 Cilium 的 Service 转发模式也要分别检查。结束时 Ctrl-C 停止 `kgctl`，确认测试 Peer 已删除，并恢复临时 Endpoint 注解。

218 在 2026-10-26 的实测：当前机器在独立 Docker 网络空间中连接临时 Peer，路由指向 `kilo0`；`10.4.0.1` 与 CoreDNS Pod `10.42.0.53` 均 ping 3/3 成功，Pod 的 TCP 53 可达。但 Kubernetes API Service `10.43.0.1:443` 和 CoreDNS Service `10.43.0.10:53` 均超时。该集群使用 Cilium kube-proxy replacement，`bpf-lb-external-clusterip=false`，与外部 Peer 访问 ClusterIP 失败相符；不要把 Service 超时误判为 WireGuard 握手失败。测试 Peer 和临时 Endpoint 注解已清理，Kilo/Cilium 仍为 1/1 Ready。

若需要让外部 Peer 访问 ClusterIP，先核对实际 Cilium Chart 和管理来源。218 使用 k3s `HelmChart/cilium` 和 `HelmChartConfig/cilium`，Cilium 1.16.4 Chart 的设置方法是在现有 `spec.valuesContent` 末尾添加：

```yaml
bpf:
  lbExternalClusterIP: true
```

保留已有 `prometheus`、`hubble` 等值；不要只改 Helm 管理的 `cilium-config` ConfigMap。218 实测 Helm 更新后 ConfigMap 变为 `bpf-lb-external-clusterip: "true"`，但原 Cilium Pod 没有自动重启，因此还需 `kubectl --kubeconfig "$KUBECONFIG" -n kube-system rollout restart ds/cilium` 并等待 `rollout status`。这是节点网络变更，先评估影响并征得用户确认。重启后用同一测试方法复测：218 的 `10.4.0.1` ping 3/3、CoreDNS Pod `10.42.0.53:53`、API Service `10.43.0.1:443`、CoreDNS Service `10.43.0.10:53` 均成功；首次复测在 Peer 尚未完成同步时全部失败，约 30 秒后恢复。测试结束后删除临时 Peer 和 Endpoint 注解；保留的仅是 Cilium Helm 设置。

## 启动卡住时

- 先看 `kubectl ... describe pod <kilo-pod>`、`kubectl ... get events --field-selector involvedObject.name=<kilo-pod>` 和 init 容器状态。`Init:0/2`、空 `imageID` 或没有事件，不能单独证明镜像下载慢。
- 若事件或节点运行时日志明确显示镜像拉取超时，再检查目标节点能否拉取镜像。需要使用私有/国内仓库时，可把同一版本和架构的镜像镜像到可达仓库，并同时修改 DaemonSet 中主容器和 init 容器的镜像；若决定从源码构建，则核对 checkout、Dockerfile、目标架构和镜像 tag 后再推送。不要仅因 Pod Pending 就重新构建。
- 在 218 的一次排查中，错误部署了独立 CNI 清单，Pod 停在 `Init:0/2` 且无事件；切换到 `kilo-k3s-cilium.yaml` 后，新 Pod 很快 `1/1 Running`，Cilium 也保持 `1/1 Ready`，未构建或推送镜像。旧 Pod 当时为何未启动容器没有得到独立证实，不能把这一现象归因为镜像拉取。

修改集群网络清单前，明确现有 CNI 和待应用清单会改写的节点文件；如果两者冲突，先说明方案并取得用户确认。
