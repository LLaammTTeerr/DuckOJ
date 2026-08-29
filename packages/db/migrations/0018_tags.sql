CREATE TABLE "tags" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name_vi" text NOT NULL,
	"name_en" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "problem_tags" (
	"problem_id" bigint NOT NULL,
	"tag_id" bigint NOT NULL,
	CONSTRAINT "problem_tags_problem_id_tag_id_pk" PRIMARY KEY("problem_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "difficulty" smallint;--> statement-breakpoint
ALTER TABLE "problem_tags" ADD CONSTRAINT "problem_tags_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_tags" ADD CONSTRAINT "problem_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tags_slug_idx" ON "tags" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "problem_tags_tag_idx" ON "problem_tags" USING btree ("tag_id","problem_id");--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_difficulty_ck" CHECK ("problems"."difficulty" IS NULL OR ("problems"."difficulty" BETWEEN 1 AND 10));
--> statement-breakpoint
-- The standard olympiad vocabulary, seeded here rather than by a script:
-- `?tag=` slugs are part of the API's surface, and a taxonomy that only
-- exists once someone remembers to run a seeder is a taxonomy the first
-- deploy ships without. Slugs are unaccented Vietnamese; both names are
-- stored, and the client picks by locale (D18 — two locales, no
-- translation table).
INSERT INTO "tags" ("slug", "name_vi", "name_en") VALUES
	('do-thi', 'Đồ thị', 'Graphs'),
	('quy-hoach-dong', 'Quy hoạch động', 'Dynamic programming'),
	('tham-lam', 'Tham lam', 'Greedy'),
	('cay', 'Cây', 'Trees'),
	('so-hoc', 'Số học', 'Number theory'),
	('xau', 'Xâu', 'Strings'),
	('hinh-hoc', 'Hình học', 'Geometry'),
	('tim-kiem-nhi-phan', 'Tìm kiếm nhị phân', 'Binary search'),
	('cau-truc-du-lieu', 'Cấu trúc dữ liệu', 'Data structures'),
	('dfs-bfs', 'DFS và BFS', 'DFS and BFS'),
	('duong-di-ngan-nhat', 'Đường đi ngắn nhất', 'Shortest paths'),
	('cay-khung', 'Cây khung', 'Spanning trees'),
	('to-hop', 'Tổ hợp', 'Combinatorics'),
	('mo-phong', 'Mô phỏng', 'Implementation'),
	('sap-xep', 'Sắp xếp', 'Sorting'),
	('hai-con-tro', 'Hai con trỏ', 'Two pointers'),
	('bit', 'Xử lý bit', 'Bitmasks'),
	('chia-de-tri', 'Chia để trị', 'Divide and conquer'),
	('luong', 'Luồng', 'Flows'),
	('cay-phan-doan', 'Cây phân đoạn', 'Segment trees'),
	('dsu', 'Tập hợp rời rạc', 'Disjoint set union'),
	('xu-ly-truoc', 'Tổng tiền tố', 'Prefix sums'),
	('luoi', 'Lưới', 'Grids'),
	('toan', 'Toán', 'Math'),
	('de-quy', 'Đệ quy', 'Recursion');
