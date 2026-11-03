"""Move only the independent media probes. Run prepare before and activate after verified cutover."""
import argparse
import json
import uuid
import boto3

REGIONS=('eu-central-1','ap-southeast-1')
POLICY='MeldiqProbeFrankfurtTransition'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['prepare','activate','finish'])
    parser.add_argument('--source',required=True)
    parser.add_argument('--target',required=True)
    args=parser.parse_args()
    session=boto3.Session()
    iam=session.client('iam')
    for region in REGIONS:
        cf=session.client('cloudformation',region_name=region)
        stack=cf.describe_stacks(StackName='meldiq-status-probes')['Stacks'][0]
        if stack['StackStatus'] not in ['CREATE_COMPLETE','UPDATE_COMPLETE']:raise RuntimeError('Probe stack is busy')
        params={p['ParameterKey']:p['ParameterValue'] for p in stack['Parameters']}
        if params['MediaBucket'] not in (args.source,args.target) or params['MonitoringPrefix']!='orbit/__status-monitoring/':raise ValueError('Unexpected current probe scope')
        function=next(o['OutputValue'] for o in stack['Outputs'] if o['OutputKey']=='Function')
        details=session.client('lambda',region_name=region).get_function_configuration(FunctionName=function)
        role=details['Role'].split('/')[-1]
        secret_id=details['Environment']['Variables']['MONITOR_SECRET_ARN']
        sm=session.client('secretsmanager',region_name=region)
        current=sm.get_secret_value(SecretId=secret_id)
        cfg=json.loads(current['SecretString']);storage=cfg['storage']
        if storage['bucket'] not in (args.source,args.target) or storage['prefix']!=params['MonitoringPrefix']:raise ValueError('Unexpected runtime storage configuration')
        if args.action=='prepare':
            document={'Version':'2012-10-17','Statement':[{'Effect':'Allow',
                'Action':['s3:PutObject','s3:GetObject','s3:GetObjectVersion','s3:DeleteObject','s3:DeleteObjectVersion'],
                'Resource':'arn:aws:s3:::'+args.target+'/'+storage['prefix']+'*'}]}
            iam.put_role_policy(RoleName=role,PolicyName=POLICY,PolicyDocument=json.dumps(document))
        if args.action=='activate' and (storage['bucket']!=args.target or (cfg.get('mediaCanary') or {}).get('delivery')!='edge'):
            if not cfg.get('mediaCanary'):raise ValueError('Authorized media fixture not installed')
            cfg['mediaCanary']['delivery']='edge'
            storage.update(bucket=args.target,region='eu-central-1')
            nxt=sm.put_secret_value(SecretId=secret_id,ClientRequestToken=str(uuid.uuid4()),SecretString=json.dumps(cfg),VersionStages=['MEDIA_CUTOVER_PENDING'])
            sm.update_secret_version_stage(SecretId=secret_id,VersionStage='AWSCURRENT',MoveToVersionId=nxt['VersionId'],RemoveFromVersionId=current['VersionId'])
        if args.action=='finish':
            if (storage['bucket'],storage['region'])!=(args.target,'eu-central-1'):raise ValueError('Runtime not switched')
            if params['MediaBucket']!=args.target:
                update=[{'ParameterKey':k,'ParameterValue':args.target} if k=='MediaBucket' else {'ParameterKey':k,'UsePreviousValue':True} for k in params]
                cf.update_stack(StackName=stack['StackId'],UsePreviousTemplate=True,Parameters=update,Capabilities=['CAPABILITY_IAM'])
                cf.get_waiter('stack_update_complete').wait(StackName=stack['StackId'])
            existing=iam.list_role_policies(RoleName=role)['PolicyNames']
            if POLICY in existing:iam.delete_role_policy(RoleName=role,PolicyName=POLICY)
        print(region,args.action,'ok',flush=True)

if __name__=='__main__':
    main()
