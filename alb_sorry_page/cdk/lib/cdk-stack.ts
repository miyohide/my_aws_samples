import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Instance, InstanceClass, InstanceSize, InstanceType, InterfaceVpcEndpointAwsService, MachineImage, Peer, Port, SecurityGroup, SubnetType, UserData, Vpc } from 'aws-cdk-lib/aws-ec2';
import { ApplicationLoadBalancer, ApplicationProtocol, ApplicationTargetGroup, ListenerAction, ListenerCondition, TargetType } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { InstanceIdTarget, LambdaTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Function, Code, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import path from 'path';

export class CdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // VPCを作成する
    const vpc = new Vpc(this, 'MyVPC', {
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'Isolated',
          subnetType: SubnetType.PRIVATE_ISOLATED,
        }
      ],
      natGateways: 0,
    });

    // Security Groupを作成する
    // ALB用のセキュリティグループを作成
    const albSg = new SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'Security Group for Application Load Balancer',
      allowAllOutbound: true,
    });

    // HTTP(80)ポートからのインバウンドトラフィックを許可
    albSg.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(80),
      'Allow HTTP traffic from anywhere'
    );

    // EC2インスタンス用のセキュリティグループを作成
    const ec2Sg = new SecurityGroup(this, 'Ec2SecurityGroup', {
      vpc,
      description: 'Security Group for EC2 instances',
      allowAllOutbound: true,
    });

    // ALBセキュリティグループからのHTTPトラフィックのみを許可
    ec2Sg.addIngressRule(
      Peer.securityGroupId(albSg.securityGroupId),
      Port.tcp(80),
      'Allow HTTP traffic from ALB only'
    );

    // VPCEndpoint用のセキュリティグループを作成
    const vpcEndpointSg = new SecurityGroup(this, 'VpcEndpointSecurityGroup', {
      vpc,
      description: 'Security Group for VPC Endpoints',
      allowAllOutbound: true,
    });

    // EC2セキュリティグループからのHTTPSトラフィックのみを許可
    vpcEndpointSg.addIngressRule(
      Peer.securityGroupId(ec2Sg.securityGroupId),
      Port.tcp(443),
      'Allow HTTPS traffic from EC2 Security Group only'
    );

    // セッションマネージャー用のVPC Endpointを作成
    const ssmEndpoint = vpc.addInterfaceEndpoint('SSMEndpoint', {
      service: InterfaceVpcEndpointAwsService.SSM,
      securityGroups: [vpcEndpointSg],
      privateDnsEnabled: true,
      subnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    const ssmMessagesEndpoint = vpc.addInterfaceEndpoint('SSMMessagesEndpoint', {
      service: InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      securityGroups: [vpcEndpointSg],
      privateDnsEnabled: true,
      subnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    const ec2MessagesEndpoint = vpc.addInterfaceEndpoint('EC2MessagesEndpoint', {
      service: InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      securityGroups: [vpcEndpointSg],
      privateDnsEnabled: true,
      subnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS
      }
    });

    // S3用のVPC Endpointを作成
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: InterfaceVpcEndpointAwsService.S3,
      subnets: [{
        subnetType: SubnetType.PRIVATE_WITH_EGRESS
      }]
    });

    // AmazonSSMManagedInstanceCoreを作成
    const role = new Role(this, 'EC2SSMRole', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
    });
    role.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );

    // Apache HTTPdをインストールする
    const userData = UserData.forLinux();
    userData.addCommands(
      "dnf install -y httpd",
      "echo '<html><body><h1>Hello from Amazon Linux 2023!</h1></body></html>' > /var/www/html/index.html",
      "systemctl enable httpd",
      "systemctl start httpd"
    );

    // EC2インスタンスを作成。OSはAmazon Linux 2023、インスタンスタイプはT3.micro
    const ec2Instance = new Instance(this, 'WebServer', {
      vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS
      },
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
      machineImage: MachineImage.latestAmazonLinux2023(),
      securityGroup: ec2Sg,
      userData: userData,
      role: role
    });

    // Lambda関数用のIAMロールを作成
    const lambdaRole = new Role(this, 'LambdaRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    // Lambda関数の基本的な実行権限を付与
    lambdaRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // Rubyランタイムを使用したLambda関数を作成
    const lambdaFunction = new Function(this, 'RubyFunction', {
      runtime: Runtime.RUBY_3_4,
      handler: 'index.handler',
      role: lambdaRole,
      code: Code.fromAsset(path.join(__dirname, '..', '..', 'lambda')),
      timeout: Duration.seconds(30),
      memorySize: 128
    });

    // インターネットに面したALBを作成
    const alb = new ApplicationLoadBalancer(this, 'InternetFacingALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    // EC2向けターゲットグループを作成
    const ec2TargetGroup = new ApplicationTargetGroup(this, 'MyEC2TargetGroup', {
      vpc: vpc,
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.INSTANCE,
      healthCheck: {
        path: '/',
        unhealthyThresholdCount: 2,
        healthyThresholdCount: 2,
        interval: Duration.seconds(30),
      },
      targets: [new InstanceIdTarget(ec2Instance.instanceId)]
    });

    // EC2インスタンスをターゲットとしたターゲットグループを作成し、ALBにリスナーを追加
    const listener = alb.addListener('Listener', {
      port: 80,
    });

    listener.addAction('EC2Forward', {
      priority: 1,
      conditions: [ListenerCondition.pathPatterns(['/*'])],
      action: ListenerAction.forward([ec2TargetGroup])
    });

    // Lambda用TargetGroupを作成
    const lambdaTargetGroup = new ApplicationTargetGroup(this, 'MyLambdaTargetGroup', {
      targetType: TargetType.LAMBDA,
      targets: [new LambdaTarget(lambdaFunction)]
    });

    listener.addAction('LambdaForward', {
      priority: 2,
      conditions: [ListenerCondition.pathPatterns(['/*'])],
      action: ListenerAction.forward([lambdaTargetGroup])
    });

    listener.addAction('DefaultFixedResponse', {
      action: ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not Found',
      }),
    });
  }
}
