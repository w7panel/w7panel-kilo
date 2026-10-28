# w7panel-kilo

Installs Kilo 0.7.0 on k3s with Cilium using Kilo's CNI compatibility mode. The chart includes the Peer CRD, RBAC, kubeconfig generation, and a privileged Kilo DaemonSet. It does not replace Cilium's CNI files.

```sh
helm install w7panel-kilo ./charts/w7panel-kilo --namespace default
kubectl -n default rollout status daemonset/kilo
```

Set `image.repository` and `image.tag` if the nodes pull Kilo from a mirror. Both the main and init containers use the same image.

The WireGuard mesh subnet defaults to `172.4.0.0/16`. Set `meshSubnet` to a non-conflicting CIDR before installation if needed. `172.4.0.0/16` is public address space, not an RFC 1918 private range. Changing this value on an existing installation changes Kilo interface addresses and requires a coordinated network migration.

Install into a new cluster only after confirming it uses k3s and Cilium. Kilo does not require the `kube-system` namespace; this release uses `default` so W7Panel's application list can discover it. If Kilo is already installed, remove or migrate the existing release before installing a second DaemonSet. Helm cannot take ownership of resources installed with `kubectl apply` automatically. Helm also does not upgrade or remove CRDs placed under `crds/`.
