CREATE TABLE "package_files" (
	"package_hash" text NOT NULL,
	"path" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	CONSTRAINT "package_files_package_hash_path_pk" PRIMARY KEY("package_hash","path")
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"hash" text PRIMARY KEY NOT NULL,
	"size_bytes" bigint NOT NULL,
	"file_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "package_files" ADD CONSTRAINT "package_files_package_hash_packages_hash_fk" FOREIGN KEY ("package_hash") REFERENCES "public"."packages"("hash") ON DELETE cascade ON UPDATE no action;