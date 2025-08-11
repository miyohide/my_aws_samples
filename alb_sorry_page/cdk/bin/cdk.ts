#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CdkStack } from '../lib/cdk-stack';

const app = new cdk.App();
new CdkStack(app, 'CdkStack', {});

cdk.Tags.of(app).add('Creator', 'CDK');
// スタック作成時の日付
const createdDate = new Date().toISOString().split('T')[0];
cdk.Tags.of(app).add('CreatedDate', createdDate);
