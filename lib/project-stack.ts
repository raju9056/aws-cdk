import * as path from "path";
import { Stack, StackProps, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";

export class ProjectStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, "FileUploadBucket", {
      bucketName: "input-files-bucket", 
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const table = new dynamodb.Table(this, "DataTable", {
      tableName: "InputData", 
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_IMAGE, 
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const lambdaRole = new iam.Role(this, "LambdaExecutionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonS3FullAccess"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonDynamoDBFullAccess"),
      ],
    });

    const uploadLambda = new lambda.Function(this, "UploadLambdaFunction", {
      functionName: "UploadLambdaFunction",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../functions/process-input-lambda")
      ),
      environment: {
        BUCKET_NAME: bucket.bucketName,
        TABLE_NAME: table.tableName,
      },
      role: lambdaRole,
    });

    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.LambdaDestination(uploadLambda)
    );

    const api = new apigateway.LambdaRestApi(this, "ApiGateway", {
      handler: uploadLambda,
      proxy: false,
      defaultMethodOptions: {
        authorizationType: apigateway.AuthorizationType.NONE,
      },
    });

    const items = api.root.addResource("items");
    items.addMethod("GET");

    const processLambda = new lambda.Function(this, "ProcessLambdaFunction", {
      functionName: "ProcessLambdaFunction",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../functions/process-script-lambda")
      ),
      environment: {
        TABLE_NAME: table.tableName,
      },
      role: lambdaRole,
    });

    table.grantStreamRead(processLambda);
    processLambda.addEventSource(
      new lambdaEventSources.DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 1,
        bisectBatchOnError: true,
        retryAttempts: 2,
      })
    );
  }
}
