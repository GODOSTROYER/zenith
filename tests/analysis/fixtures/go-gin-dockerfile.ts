/** Go + gin + pgx with a multi-stage Dockerfile that EXPOSEs 8080. */
export const goGinDockerfile: Record<string, string> = {
  "go.mod": `module example.com/api

go 1.22

require (
	github.com/gin-gonic/gin v1.9.1
	github.com/jackc/pgx/v5 v5.5.0
)
`,
  "main.go": `package main

import (
	"os"

	"github.com/gin-gonic/gin"
)

func main() {
	_ = os.Getenv("DATABASE_URL")
	r := gin.Default()
	r.GET("/healthz", func(c *gin.Context) { c.String(200, "ok") })
	r.Run(":8080")
}
`,
  Dockerfile: `FROM golang:1.22 AS build
WORKDIR /src
COPY . .
RUN go build -o /app .

FROM gcr.io/distroless/static:nonroot
COPY --from=build /app /app
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/app"]
`,
};
