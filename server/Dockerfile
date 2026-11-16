FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /breadcrumb-server ./cmd/breadcrumb-server
FROM alpine:3.22
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 breadcrumb
COPY --from=build /breadcrumb-server /usr/local/bin/breadcrumb-server
USER breadcrumb
ENV LISTEN_ADDR=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["breadcrumb-server"]
