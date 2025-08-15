require 'aws-sdk-s3'

def lambda_handler(event:, context:)
  # S3クライアントの初期化
  s3_client = Aws::S3::Client.new

  begin
    # 環境変数からバケット名とキーを取得
    bucket = ENV['S3_BUCKET_NAME']
    key = ENV['HTML_FILE_KEY']

    # S3からHTMLファイルを取得
    response = s3_client.get_object(
      bucket: bucket,
      key: key
    )
    html_content = response.body.read.force_encoding('UTF-8')

    # 503ステータスでHTMLを返す
    {
      statusCode: 503,
      headers: {
        'Content-Type': 'text/html'
      },
      body: html_content
    }

  rescue Aws::S3::Errors::ServiceError => e
    # S3エラー時のレスポンス
    {
      statusCode: 500,
      body: "Error retrieving HTML file: #{e.message}"
    }
  end
end
