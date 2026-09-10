import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const path = resolve(".local/aws/deployment.json");
const state = JSON.parse(readFileSync(path,"utf8"));
const aws = (args) => JSON.parse(execFileSync("aws",[...args,"--region",state.region,"--output","json","--no-cli-pager"],{encoding:"utf8"}) || "{}");
if (aws(["sts","get-caller-identity"]).Account !== state.accountId) throw new Error("Wrong AWS account");
const save = () => writeFileSync(path,`${JSON.stringify(state,null,2)}\n`,{mode:0o600});
const name = `${state.name}-ssm`;
if (!state.ssmRoleArn) {
  state.ssmRoleArn = aws(["iam","create-role","--role-name",name,"--assume-role-policy-document",JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{Service:"ec2.amazonaws.com"},Action:"sts:AssumeRole"}]}),"--tags",JSON.stringify([{Key:"Project",Value:"ReceivableX-P0"},{Key:"ManagedBy",Value:"receivablex-infra"}])]).Role.Arn;
  save();
}
aws(["iam","attach-role-policy","--role-name",name,"--policy-arn","arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"]);
if (!state.instanceProfileArn) {
  state.instanceProfileArn = aws(["iam","create-instance-profile","--instance-profile-name",name,"--tags",JSON.stringify([{Key:"Project",Value:"ReceivableX-P0"}])]).InstanceProfile.Arn;
  save();
}
const profile = aws(["iam","get-instance-profile","--instance-profile-name",name]).InstanceProfile;
if (!profile.Roles.length) aws(["iam","add-role-to-instance-profile","--instance-profile-name",name,"--role-name",name]);
if (!state.instanceProfileAssociationId) {
  state.instanceProfileAssociationId = aws(["ec2","associate-iam-instance-profile","--instance-id",state.instanceId,"--iam-instance-profile",`Name=${name}`]).IamInstanceProfileAssociation.AssociationId;
  state.useSsm = true;
  save();
}
console.log(JSON.stringify({instanceId:state.instanceId,ssmRoleArn:state.ssmRoleArn,instanceProfileArn:state.instanceProfileArn,useSsm:state.useSsm},null,2));
