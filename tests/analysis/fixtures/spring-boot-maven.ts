/** Spring Boot (Maven) with postgres, redis, actuator and Flyway; port from server.port. */
export const springBootMaven: Record<string, string> = {
  "pom.xml": `<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.3</version>
  </parent>
  <artifactId>catalog</artifactId>
  <properties><java.version>21</java.version></properties>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-actuator</artifactId></dependency>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-data-redis</artifactId></dependency>
    <dependency><groupId>org.postgresql</groupId><artifactId>postgresql</artifactId></dependency>
    <dependency><groupId>org.flywaydb</groupId><artifactId>flyway-core</artifactId></dependency>
  </dependencies>
</project>
`,
  "src/main/resources/application.properties": `server.port=\${PORT:8081}
spring.datasource.url=jdbc:postgresql://\${DB_HOST:localhost}:5432/catalog
spring.datasource.password=\${DB_PASSWORD}
`,
  "src/main/resources/db/migration/V1__init.sql": "CREATE TABLE item (id int);",
};
