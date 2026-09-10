import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const region = process.env.AWS_REGION ?? "us-east-1";
const expectedAccount = process.env.AWS_EXPECTED_ACCOUNT_ID;
if (!expectedAccount || !/^\d{12}$/.test(expectedAccount)) throw new Error("Set AWS_EXPECTED_ACCOUNT_ID to the reviewed account before provisioning.");
const directory = resolve(".local/aws");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const stateFile = resolve(directory, "deployment.json");
const aws = (args) => JSON.parse(execFileSync("aws", [...args, "--region", region, "--output", "json", "--no-cli-pager"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
const identity = aws(["sts", "get-caller-identity"]);
if (identity.Account !== expectedAccount) throw new Error("AWS account does not match expected account.");
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { accountId: identity.Account, region, name: `receivablex-p0-${new Date().toISOString().slice(0,10)}-${randomUUID().slice(0,6)}` };
if (state.accountId !== identity.Account || state.region !== region) throw new Error("Deployment state belongs to another AWS account or region.");
const save = () => writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
const tags = [{ Key: "Name", Value: state.name }, { Key: "Project", Value: "ReceivableX-P0" }, { Key: "ManagedBy", Value: "receivablex-infra" }];
save();
if (!state.vpcId) {
  const vpc = aws(["ec2", "describe-vpcs", "--filters", "Name=is-default,Values=true"]).Vpcs[0];
  if (!vpc) throw new Error("No default VPC. Choose a reviewed VPC explicitly rather than creating broad networking resources.");
  const subnet = aws(["ec2", "describe-subnets", "--filters", `Name=vpc-id,Values=${vpc.VpcId}`]).Subnets.find((entry) => entry.MapPublicIpOnLaunch && entry.AvailableIpAddressCount > 10);
  if (!subnet) throw new Error("No suitable public subnet.");
  state.vpcId = vpc.VpcId; state.subnetId = subnet.SubnetId; save();
}
if (!state.sshKeyPath) {
  state.sshKeyPath = resolve(directory, `${state.name}.pem`);
  if (!existsSync(state.sshKeyPath)) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", state.name, "-f", state.sshKeyPath], { stdio: "ignore" });
  chmodSync(state.sshKeyPath, 0o600); save();
}
if (!state.keyPairId) {
  const result = aws(["ec2", "import-key-pair", "--key-name", state.name, "--public-key-material", `fileb://${state.sshKeyPath}.pub`, "--tag-specifications", JSON.stringify([{ ResourceType: "key-pair", Tags: tags }])]);
  state.keyPairId = result.KeyPairId; save();
}
if (!state.securityGroupId) {
  state.securityGroupId = aws(["ec2", "create-security-group", "--group-name", state.name, "--description", "ReceivableX P0 HTTPS and operator-only SSH", "--vpc-id", state.vpcId, "--tag-specifications", JSON.stringify([{ ResourceType: "security-group", Tags: tags }])]).GroupId; save();
}
if (!state.ingressConfigured) {
  const ip = (await (await fetch("https://checkip.amazonaws.com")).text()).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error("Could not determine operator IPv4.");
  const rules = [80,443].map((port) => ({ IpProtocol: "tcp", FromPort: port, ToPort: port, IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "Public HTTPS and ACME validation" }] }));
  rules.push({ IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: `${ip}/32`, Description: "Operator SSH only" }] });
  aws(["ec2", "authorize-security-group-ingress", "--group-id", state.securityGroupId, "--ip-permissions", JSON.stringify(rules)]);
  state.operatorCidr = `${ip}/32`; state.ingressConfigured = true; save();
}
if (!state.instanceId) {
  const ami = aws(["ssm", "get-parameter", "--name", "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"]).Parameter.Value;
  const result = aws(["ec2", "run-instances", "--image-id", ami, "--instance-type", "t3.medium", "--count", "1", "--key-name", state.name, "--subnet-id", state.subnetId, "--security-group-ids", state.securityGroupId, "--associate-public-ip-address", "--metadata-options", "HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled", "--credit-specification", "CpuCredits=standard", "--block-device-mappings", JSON.stringify([{ DeviceName: "/dev/sda1", Ebs: { VolumeSize: 30, VolumeType: "gp3", Encrypted: true, DeleteOnTermination: false } }]), "--tag-specifications", JSON.stringify([{ ResourceType: "instance", Tags: tags }, { ResourceType: "volume", Tags: tags }]), "--user-data", `file://${resolve("scripts/deploy/aws/cloud-init.yaml")}`, "--client-token", state.name]);
  state.instanceId = result.Instances[0].InstanceId; state.ami = ami; save();
}
if (!state.allocationId) {
  const address = aws(["ec2", "allocate-address", "--domain", "vpc", "--tag-specifications", JSON.stringify([{ ResourceType: "elastic-ip", Tags: tags }])]);
  state.allocationId = address.AllocationId; state.publicIp = address.PublicIp; state.hostname = `receivablex-${address.PublicIp.replaceAll(".", "-")}.sslip.io`; save();
}
if (!state.associationId) {
  // run-instances may still be pending. Re-run this script once running if association rejects.
  state.associationId = aws(["ec2", "associate-address", "--instance-id", state.instanceId, "--allocation-id", state.allocationId]).AssociationId; save();
}
console.log(JSON.stringify({ instanceId: state.instanceId, securityGroupId: state.securityGroupId, allocationId: state.allocationId, publicIp: state.publicIp, hostname: state.hostname, stateFile }, null, 2));
