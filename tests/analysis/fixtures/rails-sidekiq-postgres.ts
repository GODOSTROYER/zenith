/** Rails + postgres (database.yml) + sidekiq + whenever + Active Storage S3. */
export const railsSidekiqPostgres: Record<string, string> = {
  Gemfile: `source "https://rubygems.org"
ruby "3.3.0"
gem "rails", "~> 7.1"
gem "pg"
gem "puma"
gem "sidekiq"
gem "whenever"
gem "aws-sdk-s3"
group :development, :test do
  gem "sqlite3"
end
`,
  "config/database.yml": `default: &default
  adapter: postgresql
  pool: 5

development:
  <<: *default
  database: app_development

production:
  <<: *default
  url: <%= ENV["DATABASE_URL"] %>
`,
  "config/routes.rb": `Rails.application.routes.draw do
  get "up" => "rails/health#show", as: :rails_health_check
end
`,
  "config/schedule.rb": `every 1.day, at: "4:30 am" do
  runner "Report.daily"
end
`,
  "config/storage.yml": `amazon:
  service: S3
  bucket: <%= ENV["S3_BUCKET"] %>
`,
  "config/sidekiq.yml": ":concurrency: 5\n",
  "config/puma.rb": `port ENV.fetch("PORT") { 3000 }\n`,
  "db/migrate/20240101000000_create_users.rb": "class CreateUsers < ActiveRecord::Migration[7.1]; end\n",
};
