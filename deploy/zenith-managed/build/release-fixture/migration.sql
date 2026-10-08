begin;
create table if not exists public.j6_release_probe (id integer primary key, marker text not null);
insert into public.j6_release_probe(id,marker) values(1,'zenith-j6-source-release') on conflict(id) do update set marker=excluded.marker;
commit;
