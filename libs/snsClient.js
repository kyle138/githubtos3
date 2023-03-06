import { SNSClient } from "@aws-sdk/client-sns";
const snsClient = new SNSClient({ region: 'us-east-1' });

export { snsClient };
