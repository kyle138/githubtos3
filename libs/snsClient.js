import { SNSClient } from "@aws-sdk/client-sns";
const SNS = new SNSClient({ region: 'us-east-1' });

export { snsClient };
