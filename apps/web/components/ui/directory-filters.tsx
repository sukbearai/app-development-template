import Link from "next/link";

type FilterField = {
  name: string;
  label: string;
  value: string;
  options?: { value: string; label: string }[];
};

export function DirectoryFilters({
  path,
  search,
  limit,
  direction,
  fields,
}: {
  path: string;
  search: string;
  limit: number;
  direction: "asc" | "desc";
  fields: FilterField[];
}) {
  return (
    <form action={path} method="get" className="admin-form compact">
      <label>
        搜索
        <input name="search" defaultValue={search} maxLength={200} placeholder="输入搜索内容" />
      </label>
      {fields.map((field) => (
        <div key={field.name}>
          <label htmlFor={`filter-${field.name}`}>{field.label}</label>
          {field.options ? (
            <select id={`filter-${field.name}`} name={field.name} defaultValue={field.value}>
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`filter-${field.name}`}
              name={field.name}
              defaultValue={field.value}
              maxLength={200}
            />
          )}
        </div>
      ))}
      <div>
        <label htmlFor="filter-direction">顺序</label>
        <select id="filter-direction" name="direction" defaultValue={direction}>
          <option value="desc">降序</option>
          <option value="asc">升序</option>
        </select>
      </div>
      <label>
        每页条数
        <input name="limit" type="number" min={1} max={100} defaultValue={limit} required />
      </label>
      <div className="section-actions">
        <button className="button primary" type="submit">
          应用筛选
        </button>
        <Link className="button secondary" href={path}>
          重置
        </Link>
      </div>
    </form>
  );
}
